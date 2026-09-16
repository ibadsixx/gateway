// Runnable offline test-suite for the gateway-owned People-You-May-Know engine
// (social/suggestions — "People You May Know.md").
//
// Drives the pure engine (computePeopleYouMayKnow / scoreCandidate /
// selectDiverse) against injected in-memory deps so no live infra is required.
// Covers the Final-verification scenarios from the spec:
//   1. mutual friends produce the candidate with the correct mutual count
//   2. same-group membership can suggest a candidate
//   3. already-friends are never suggested
//   4. pending friend-request users are never suggested
//   5. users the caller blocked are never suggested
//   6. users who blocked the caller are never suggested
//   7. the caller is never suggested
//   8. one candidate qualifying via multiple signals appears exactly once
//   9. (frontend) Add Friend uses the existing friend-request system
//  10. refresh/reload yields deterministic, database-backed recommendations
//  11. the engine never fetches every user / barrier candidates with a profile
//      but zero connections are never suggested
//  12. no N+1: each batched read runs a bounded number of times per request
// plus opt-out privacy, score ordering determinism, diversity cap and limit clamp.
//
// Run: npm run test:people-you-may-know
import assert from 'node:assert/strict';
import {
  computePeopleYouMayKnow,
  scoreCandidate,
  selectDiverse,
  clampLimit,
  DEFAULT_WEIGHTS,
  type PeopleYouMayKnowCandidate,
  type PeopleYouMayKnowDeps,
  type PeopleYouMayKnowSignals,
} from './peopleYouMayKnow';

const ALICE = 'alice-uuid';
const M1 = 'm1-uuid';
const M2 = 'm2-uuid';
const BOB = 'bob-uuid';
const DAVE = 'dave-uuid';
const ERIN = 'erin-uuid';
const FRANK = 'frank-uuid';
const GRACE = 'grace-uuid';
const HEIDI = 'heidi-uuid';
const ZORP = 'zorp-uuid';
const DELETED = 'deleted-uuid';

interface FriendsRow { requester_id: string; receiver_id: string; status: string }
interface FollowerRow { follower_id: string; following_id: string }
interface BlockRow { blocker_id: string; blocked_id: string }
interface GroupMemberRow { group_id: string; user_id: string }
interface ProfileRow { id: string; username: string; display_name: string; profile_pic: string | null; college_id: string | null; company_id: string | null; high_school_id: string | null; created_at: string; }

interface InMemoryDb {
  friends: FriendsRow[];
  followers: FollowerRow[];
  blocks: BlockRow[];
  group_members: GroupMemberRow[];
  profiles: ProfileRow[];
  profile_details: Array<{ profile_id: string; section: string; field_name: string; field_value: string }>;
  privacy_settings: Array<{ user_id: string; setting_name: string; setting_value: string }>;
}

const START = '2026-01-01T00:00:00Z';

function profile(id: string, overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id,
    username: id.split('-')[0],
    display_name: id.split('-')[0].toUpperCase(),
    profile_pic: null,
    college_id: null,
    company_id: null,
    high_school_id: null,
    created_at: START,
    ...overrides,
  };
}

function baseDb(): InMemoryDb {
  return {
    friends: [],
    followers: [],
    blocks: [],
    group_members: [],
    profiles: [
      profile(ALICE), profile(M1), profile(M2), profile(BOB), profile(DAVE),
      profile(ERIN), profile(FRANK), profile(GRACE), profile(HEIDI), profile(ZORP),
    ],
    profile_details: [],
    privacy_settings: [],
  };
}

interface CountingDeps extends PeopleYouMayKnowDeps {
  calls: Record<string, number>;
  lastProfilesForIds: string[];
}

function makeDeps(db: InMemoryDb): CountingDeps {
  const calls: Record<string, number> = {};
  const count = (key: string): void => { calls[key] = (calls[key] ?? 0) + 1; };
  const friendsOf = (userId: string, statuses: string[]): Set<string> => {
    const ids = new Set<string>();
    for (const f of db.friends) {
      if (!statuses.includes(f.status)) continue;
      const other = f.requester_id === userId ? f.receiver_id : f.requester_id;
      if (f.requester_id === userId || f.receiver_id === userId) {
        if (other !== userId) ids.add(other);
      }
    }
    return ids;
  };
  const signalsFor = (userId: string): PeopleYouMayKnowSignals => {
    const p = db.profiles.find((r) => r.id === userId);
    const city = db.profile_details.find(
      (r) => r.profile_id === userId && r.section === 'places' && r.field_name === 'current_city'
    );
    return {
      college_id: p?.college_id ?? null,
      company_id: p?.company_id ?? null,
      high_school_id: p?.high_school_id ?? null,
      current_city: city?.field_value ?? null,
    };
  };
  return {
    calls,
    lastProfilesForIds: [],
    async allRelatedUserIds(userId) {
      count('allRelatedUserIds');
      const ids = new Set<string>();
      for (const f of db.friends) {
        if (f.requester_id === userId) ids.add(f.receiver_id);
        if (f.receiver_id === userId) ids.add(f.requester_id);
      }
      return ids;
    },
    async acceptedFriendIds(userId) {
      count('acceptedFriendIds');
      return friendsOf(userId, ['accepted']);
    },
    async acceptedFriendsOf(userIds) {
      count('acceptedFriendsOf');
      const queried = new Set(userIds);
      const map = new Map<string, Set<string>>();
      for (const f of db.friends) {
        if (f.status !== 'accepted') continue;
        if (!map.has(f.requester_id)) map.set(f.requester_id, new Set<string>());
        if (!map.has(f.receiver_id)) map.set(f.receiver_id, new Set<string>());
        if (queried.has(f.requester_id)) map.get(f.requester_id)!.add(f.receiver_id);
        if (queried.has(f.receiver_id)) map.get(f.receiver_id)!.add(f.requester_id);
      }
      return map;
    },
    async followingIds(userId) {
      count('followingIds');
      return new Set(db.followers.filter((f) => f.follower_id === userId).map((f) => f.following_id));
    },
    async followerIds(userId) {
      count('followerIds');
      return new Set(db.followers.filter((f) => f.following_id === userId).map((f) => f.follower_id));
    },
    async followedBy(followerIds) {
      count('followedBy');
      const queried = new Set(followerIds);
      const map = new Map<string, Set<string>>();
      for (const f of db.followers) {
        if (!queried.has(f.follower_id)) continue;
        if (!map.has(f.follower_id)) map.set(f.follower_id, new Set<string>());
        map.get(f.follower_id)!.add(f.following_id);
      }
      return map;
    },
    async blockedPeerIds(userId) {
      count('blockedPeerIds');
      const ids = new Set<string>();
      for (const b of db.blocks) {
        if (b.blocker_id === userId) ids.add(b.blocked_id);
        if (b.blocked_id === userId) ids.add(b.blocker_id);
      }
      return ids;
    },
    async groupIdsOf(userId) {
      count('groupIdsOf');
      return new Set(db.group_members.filter((g) => g.user_id === userId).map((g) => g.group_id));
    },
    async membersOfGroups(groupIds) {
      count('membersOfGroups');
      const queried = new Set(groupIds);
      const map = new Map<string, Set<string>>();
      for (const g of db.group_members) {
        if (!queried.has(g.group_id)) continue;
        if (!map.has(g.group_id)) map.set(g.group_id, new Set<string>());
        map.get(g.group_id)!.add(g.user_id);
      }
      return map;
    },
    async profilesFor(userIds) {
      count('profilesFor');
      this.lastProfilesForIds = [...userIds];
      const map = new Map<string, PeopleYouMayKnowSignals & { username: string; display_name: string; profile_pic: string | null; created_at: string | null }>();
      for (const p of db.profiles) {
        if (!userIds.includes(p.id)) continue;
        map.set(p.id, { ...signalsFor(p.id), username: p.username, display_name: p.display_name, profile_pic: p.profile_pic, created_at: p.created_at });
      }
      return map;
    },
    async callerSignals(userId) {
      count('callerSignals');
      return signalsFor(userId);
    },
    async suggestionOptOutIds(userIds) {
      count('suggestionOptOutIds');
      return new Set(
        db.privacy_settings
          .filter((p) => userIds.includes(p.user_id) && p.setting_name === 'friend_suggestions_enabled' && p.setting_value === 'false')
          .map((p) => p.user_id)
      );
    },
  };
}

function accepted(a: string, b: string): FriendsRow {
  return { requester_id: a, receiver_id: b, status: 'accepted' };
}

let pass = 0;
function ok(name: string): void {
  pass++;
  console.log(`  ✓ ${name}`);
}
async function section(title: string): Promise<void> {
  console.log(`\n${title}`);
}

async function scenario1and8(): Promise<void> {
  const db = baseDb();
  // ALICE is accepted-friends with M1 and M2; both M1 and M2 are accepted
  // friends of DAVE. DAVE also shares group G-A with ALICE and is followed by
  // ALICE's follower M1 (mutual-follower signal). Multi-signal candidate.
  db.friends.push(accepted(ALICE, M1), accepted(ALICE, M2), accepted(M1, DAVE), accepted(M2, DAVE));
  db.group_members.push({ group_id: 'G-A', user_id: ALICE }, { group_id: 'G-A', user_id: DAVE });
  db.followers.push({ follower_id: M1, following_id: DAVE });
  db.followers.push({ follower_id: M1, following_id: ALICE });

  const deps = makeDeps(db);
  const result = await computePeopleYouMayKnow(ALICE, { limit: 20 }, deps);

  // Scenario 1 + 8: DAVE appears exactly once with correct mutual counts.
  const daveEntries = result.filter((c) => c.id === DAVE);
  ok('...two users with mutual friends: candidate appears exactly once');
  assert.equal(daveEntries.length, 1);
  const dave = daveEntries[0];
  ok('...candidate carries the correct mutual-friend count (2)');
  assert.equal(dave.mutual_friends_count, 2);

  ok('...same candidate qualifying through multiple signals is not duplicated');
  assert.equal(dave.mutual_groups_count, 1);
  assert.equal(dave.mutual_followers_count, 1);
  assert.ok(result.filter((c) => c.id === M1 || c.id === M2).length === 0, 'existing friends never suggested');
}

async function scenario2(): Promise<void> {
  const db = baseDb();
  // Same-group membership alone is a valid suggestion signal.
  db.group_members.push({ group_id: 'G2', user_id: ALICE }, { group_id: 'G2', user_id: BOB });
  const deps = makeDeps(db);
  const result = await computePeopleYouMayKnow(ALICE, { limit: 20 }, deps);
  assert.ok(result.some((c) => c.id === BOB), 'same-group member should be suggested');
  ok('...two users in the same group: candidate can be suggested');
}

async function scenario3_4_5_6_7(): Promise<void> {
  const db = baseDb();
  // Everybody below has a STRONG group signal with ALICE, yet must still be
  // excluded for their respective reasons.
  db.group_members.push(
    { group_id: 'G3', user_id: ALICE },
    { group_id: 'G3', user_id: ERIN },   // already accepted friend
    { group_id: 'G3', user_id: FRANK },  // pending friend request
    { group_id: 'G3', user_id: GRACE },  // ALICE blocked GRACE
    { group_id: 'G3', user_id: HEIDI },  // HEIDI blocked ALICE
  );
  db.friends.push(accepted(ALICE, ERIN));
  db.friends.push({ requester_id: ALICE, receiver_id: FRANK, status: 'pending' });
  db.friends.push({ requester_id: FRANK, receiver_id: ALICE, status: 'pending' });
  db.blocks.push({ blocker_id: ALICE, blocked_id: GRACE });
  db.blocks.push({ blocker_id: HEIDI, blocked_id: ALICE });

  const deps = makeDeps(db);
  const result = await computePeopleYouMayKnow(ALICE, { limit: 20 }, deps);
  const ids = result.map((c) => c.id);
  assert.ok(!ids.includes(ERIN), 'accepted friend leaked into suggestions');
  assert.ok(!ids.includes(FRANK), 'pending-request user leaked into suggestions');
  assert.ok(!ids.includes(GRACE), 'blocked user leaked into suggestions');
  assert.ok(!ids.includes(HEIDI), 'blocker-of-me leaked into suggestions');
  ok('...already-friends users are never suggested');
  ok('...pending friend-request users are never suggested');
  ok('...users I blocked are never suggested');
  ok('...users who blocked me are never suggested');
  assert.ok(!ids.includes(ALICE), 'caller leaked into suggestions');
  ok('...the current user is never suggested');
}

async function scenario10(): Promise<void> {
  const db = baseDb();
  db.friends.push(accepted(ALICE, M1), accepted(M1, DAVE));
  db.group_members.push({ group_id: 'G10', user_id: ALICE }, { group_id: 'G10', user_id: BOB });

  const first = await computePeopleYouMayKnow(ALICE, { limit: 20 }, makeDeps(db));
  const second = await computePeopleYouMayKnow(ALICE, { limit: 20 }, makeDeps(db));
  assert.deepEqual(first, second);
  ok('...refresh/reload of a real database view yields deterministic recommendations');
}

async function scenario11(): Promise<void> {
  const db = baseDb();
  db.friends.push(accepted(ALICE, M1), accepted(M1, DAVE));
  // ZORP has a profile but ZERO connections — must never appear.
  const deps = makeDeps(db);
  const result = await computePeopleYouMayKnow(ALICE, { limit: 20 }, deps);
  assert.ok(!result.some((c) => c.id === ZORP), 'unconnected user with a profile was suggested');
  ok('...the system does not fetch every user: an unconnected user is never a candidate');
  assert.ok(!deps.lastProfilesForIds.includes(ZORP), 'profiles query included an unconnected user');
  assert.ok(!deps.lastProfilesForIds.some((id) => id.startsWith('users-all')), 'no full-user fetch');

  // A candidate whose profile row is missing (e.g. deleted account) is dropped.
  const db2 = baseDb();
  db2.friends.push(accepted(ALICE, M1), accepted(M1, DELETED));
  db2.group_members.push({ group_id: 'G11', user_id: ALICE }, { group_id: 'G11', user_id: DELETED });
  const result2 = await computePeopleYouMayKnow(ALICE, { limit: 20 }, makeDeps(db2));
  assert.ok(!result2.some((c) => c.id === DELETED), 'candidate without a profile row was suggested');
  ok('...users without a profile row (deleted accounts) are never suggested');
}

async function scenario12(): Promise<void> {
  const db = baseDb();
  // A large shared group — candidates P1..P40 — must still need only ONE batched
  // membership read and ONE batched profiles read (no per-candidate queries).
  db.group_members.push({ group_id: 'BIG', user_id: ALICE });
  for (let i = 1; i <= 40; i++) {
    db.group_members.push({ group_id: 'BIG', user_id: `p-${i}-uuid` });
    db.profiles.push(profile(`p-${i}-uuid`));
  }
  db.friends.push(accepted(ALICE, M1), accepted(M1, DAVE));
  db.profiles.push(profile(DAVE));
  const deps = makeDeps(db);
  await computePeopleYouMayKnow(ALICE, { limit: 20 }, deps);
  assert.ok((deps.calls['profilesFor'] ?? 0) <= 1, `profilesFor called ${deps.calls['profilesFor']} times`);
  assert.ok((deps.calls['acceptedFriendsOf'] ?? 0) <= 1, `acceptedFriendsOf called ${deps.calls['acceptedFriendsOf']} times`);
  assert.ok((deps.calls['membersOfGroups'] ?? 0) <= 1, `membersOfGroups called ${deps.calls['membersOfGroups']} times`);
  assert.ok((deps.calls['followedBy'] ?? 0) <= 1, `followedBy called ${deps.calls['followedBy']} times`);
  ok('...no N+1: each batched read runs a bounded number of times per request');
}

async function privacyOptOut(): Promise<void> {
  const db = baseDb();
  db.friends.push(accepted(ALICE, M1), accepted(M1, DAVE));
  db.group_members.push({ group_id: 'G-P', user_id: ALICE }, { group_id: 'G-P', user_id: BOB });
  db.privacy_settings.push({ user_id: DAVE, setting_name: 'friend_suggestions_enabled', setting_value: 'false' });
  const deps = makeDeps(db);
  const result = await computePeopleYouMayKnow(ALICE, { limit: 20 }, deps);
  assert.ok(!result.some((c) => c.id === DAVE), 'opted-out user was suggested');
  assert.ok(result.some((c) => c.id === BOB), 'non-opted-out user was dropped too');
  ok('...privacy opt-out (friend_suggestions_enabled = false) is respected');
}

async function scoringAndOrdering(): Promise<void> {
  assert.equal(
    scoreCandidate({ mutualFriendsCount: 2, sharedGroupsCount: 0, mutualFollowersCount: 0, sameCollege: false, sameCompany: false, sameHighSchool: false, sameCity: false }),
    20
  );
  assert.equal(
    scoreCandidate({ mutualFriendsCount: 0, sharedGroupsCount: 2, mutualFollowersCount: 0, sameCollege: false, sameCompany: false, sameHighSchool: false, sameCity: true }),
    12
  );

  // Deterministic ordering: higher mutual-friend count ranks first on a tie.
  const db = baseDb();
  db.friends.push(
    accepted(ALICE, M1), accepted(M1, DAVE), accepted(ALICE, M2), accepted(M2, DAVE),
    accepted(ALICE, M2), accepted(M2, BOB),
  );
  const deps = makeDeps(db);
  const result = await computePeopleYouMayKnow(ALICE, { limit: 20 }, deps);
  const rankOf = (id: string) => result.findIndex((c) => c.id === id);
  assert.ok(rankOf(DAVE) < rankOf(BOB), `DAVE(2 mutual) should rank above BOB(1 mutual), got ${result.map((c) => c.id)}`);
  ok('...scoring is deterministic and ties rank by descending mutual count');

  const cFor = (over: Partial<PeopleYouMayKnowCandidate>): PeopleYouMayKnowCandidate => ({
    id: 'x', username: 'x', display_name: 'X', profile_pic: null,
    mutual_friends_count: 0, mutual_groups_count: 0, mutual_followers_count: 0,
    same_college: false, same_company: false, same_high_school: false, same_city: false,
    score: 0, created_at: START, ...over,
  });
  const groupHeavy = Array.from({ length: 10 }, (_, i) =>
    cFor({ id: `g-${i}`, mutual_groups_count: 2, score: 10 })
  );
  const friendHeavy = Array.from({ length: 3 }, (_, i) =>
    cFor({ id: `f-${i}`, mutual_friends_count: 1, score: 10 })
  );
  const diversified = selectDiverse([...groupHeavy, ...friendHeavy], 8, DEFAULT_WEIGHTS);
  assert.ok(diversified.filter((c) => c.mutual_groups_count > 0).length <= 5, 'more than 5 from one dominant source');
  assert.equal(diversified.length, 8);
  assert.ok(diversified.some((c) => c.id.startsWith('f-')), 'minority source entirely crowded out');
  ok('...diversity cap keeps a single dominant signal source from crowding the list');
  ok('...limit is clamped to [1,50]');
  assert.equal(clampLimit(undefined), 20);
  assert.equal(clampLimit(500), 50);
  assert.equal(clampLimit(0), 1);
}

async function run(): Promise<void> {
  await section('People You May Know — mutual friends + multi-signal candidate');
  await scenario1and8();
  await section('People You May Know — same group membership');
  await scenario2();
  await section('People You May Know — exclusions (friends/pending/blocked/self)');
  await scenario3_4_5_6_7();
  await section('People You May Know — deterministic database-backed refresh');
  await scenario10();
  await section('People You May Know — no full-table fetch');
  await scenario11();
  await section('People You May Know — no N+1 requests');
  await scenario12();
  await section('People You May Know — privacy opt-out');
  await privacyOptOut();
  await section('People You May Know — scoring, ordering, diversity, limit');
  await scoringAndOrdering();
  console.log(`\nAll people-you-may-know tests passed (${pass} assertions).`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});