import { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';

// Gateway-owned "People You May Know" (social/suggestions.md).
//
// The historical get_people_you_may_know DB function could never be proxied
// reliably: it joins `profiles` (profiles host) with `blocks` (blocking host),
// which is a cross-project read the RPC proxy cannot satisfy. The Gateway is
// the appropriate place to compute suggestions because it is the single choke
// point for authenticated reads and can query every host directly with service
// credentials.
//
// Spec rules implemented here:
//   - Candidate generation is SERVER-SIDE from real graph edges (mutual
//     accepted friendships, shared group membership, follow relationships),
//     never from a full-profile / full-user fetch.
//   - Every candidate must have at least one concrete connection signal;
//     unconnected users (even with a profile) are never suggested.
//   - Excluded: the caller, anyone with ANY friends row (accepted, pending,
//     rejected — either direction), blocked peers (both directions), people the
//     caller already follows, users with no `profiles` row (deleted /
//     deactivated), and users who opted out via
//     privacy_settings.friend_suggestions_enabled = 'false'.
//   - Deterministic scoring: mutual friends ×10, shared groups ×5, mutual
//     followers / follow-reach ×3, same college ×3, same company ×3, same
//     high school ×3, same city ×2. Ties break by descending score then
//     descending mutual friends then descending shared groups then descending
//     created_at (deterministic via ascending id as final tiebreak).
//   - Diversity cap: no single dominant signal source may fill more than
//     ceil(limit * 0.6) of the list, so a big shared group cannot crowd out
//     every other signal.
//   - No N+1: every datapoint is read in a small, constant number of batched
//     queries across hosts; no per-candidate lookups.

export interface PeopleYouMayKnowSignals {
  college_id: string | null;
  company_id: string | null;
  high_school_id: string | null;
  current_city: string | null;
}

export interface PeopleYouMayKnowCandidate {
  id: string;
  username: string;
  display_name: string;
  profile_pic: string | null;
  mutual_friends_count: number;
  mutual_groups_count: number;
  mutual_followers_count: number;
  same_college: boolean;
  same_company: boolean;
  same_high_school: boolean;
  same_city: boolean;
  score: number;
  created_at: string | null;
}

export interface PeopleYouMayKnowWeights {
  mutualFriends: number;
  sharedGroups: number;
  mutualFollowers: number;
  sameCollege: number;
  sameCompany: number;
  sameHighSchool: number;
  sameCity: number;
}

export const DEFAULT_WEIGHTS: PeopleYouMayKnowWeights = {
  mutualFriends: 10,
  sharedGroups: 5,
  mutualFollowers: 3,
  sameCollege: 3,
  sameCompany: 3,
  sameHighSchool: 3,
  sameCity: 2,
};

export interface CandidateSignals {
  mutualFriendsCount: number;
  sharedGroupsCount: number;
  mutualFollowersCount: number;
  sameCollege: boolean;
  sameCompany: boolean;
  sameHighSchool: boolean;
  sameCity: boolean;
}

export interface CandidateScore {
  mutualFriends: number;
  sharedGroups: number;
  mutualFollowers: number;
}

export function scoreCandidate(
  signals: CandidateSignals,
  weights: PeopleYouMayKnowWeights = DEFAULT_WEIGHTS
): number {
  return (
    signals.mutualFriendsCount * weights.mutualFriends +
    signals.sharedGroupsCount * weights.sharedGroups +
    signals.mutualFollowersCount * weights.mutualFollowers +
    (signals.sameCollege ? weights.sameCollege : 0) +
    (signals.sameCompany ? weights.sameCompany : 0) +
    (signals.sameHighSchool ? weights.sameHighSchool : 0) +
    (signals.sameCity ? weights.sameCity : 0)
  );
}

type DominantSource = 'mutual_friends' | 'shared_groups' | 'follows' | 'shared_profile';

function dominantSource(c: PeopleYouMayKnowCandidate, weights: PeopleYouMayKnowWeights): DominantSource {
  const contributions: Record<DominantSource, number> = {
    mutual_friends: c.mutual_friends_count * weights.mutualFriends,
    shared_groups: c.mutual_groups_count * weights.sharedGroups,
    follows: c.mutual_followers_count * weights.mutualFollowers,
    shared_profile:
      (c.same_college ? weights.sameCollege : 0) +
      (c.same_company ? weights.sameCompany : 0) +
      (c.same_high_school ? weights.sameHighSchool : 0) +
      (c.same_city ? weights.sameCity : 0),
  };
  let best: DominantSource = 'mutual_friends';
  for (const key of ['shared_groups', 'follows', 'shared_profile'] as const) {
    if (contributions[key] > contributions[best]) best = key;
  }
  return best;
}

// Diversity cap: no single dominant source may supply more than
// ceil(limit * 0.6) of the result, applied in score order so the highest
// scoring candidates always make the cut first.
export function selectDiverse(
  candidates: PeopleYouMayKnowCandidate[],
  limit: number,
  weights: PeopleYouMayKnowWeights = DEFAULT_WEIGHTS
): PeopleYouMayKnowCandidate[] {
  if (limit <= 0 || candidates.length === 0) return [];
  const cap = Math.max(1, Math.ceil(limit * 0.6));
  const sorted = [...candidates];
  const bucketOf = new Map<string, DominantSource>();
  const bucketCount = new Map<DominantSource, number>();
  for (const c of sorted) {
    const dom = dominantSource(c, weights);
    bucketOf.set(c.id, dom);
    bucketCount.set(dom, (bucketCount.get(dom) ?? 0) + 1);
  }
  const keptByBucket = new Map<DominantSource, number>();
  const result: PeopleYouMayKnowCandidate[] = [];
  for (const c of sorted) {
    const dom = bucketOf.get(c.id)!;
    const kept = keptByBucket.get(dom) ?? 0;
    if (kept >= cap && (bucketCount.get(dom) ?? 0) > cap) continue;
    keptByBucket.set(dom, kept + 1);
    result.push(c);
    if (result.length >= limit) break;
  }
  return result;
}

export interface PeopleYouMayKnowDeps {
  // Other side of ANY friends row involving `userId` (any status, either direction).
  allRelatedUserIds(userId: string): Promise<Set<string>>;
  // Other side of every ACCEPTED friendship row involving `userId`.
  acceptedFriendIds(userId: string): Promise<Set<string>>;
  // Accepted-friend graph for a batch of user ids: id -> accepted friend ids.
  acceptedFriendsOf(userIds: string[]): Promise<Map<string, Set<string>>>;
  // User ids `userId` follows.
  followingIds(userId: string): Promise<Set<string>>;
  // User ids following `userId`.
  followerIds(userId: string): Promise<Set<string>>;
  // follower id -> set of ids they follow (batched).
  followedBy(followerIds: string[]): Promise<Map<string, Set<string>>>;
  // Blocker/blocked peers of `userId` in BOTH directions.
  blockedPeerIds(userId: string): Promise<Set<string>>;
  // Group ids `userId` belongs to.
  groupIdsOf(userId: string): Promise<Set<string>>;
  // group id -> member user ids (batched).
  membersOfGroups(groupIds: string[]): Promise<Map<string, Set<string>>>;
  // Profile rows (with affinity ids and city) for `userIds`; missing ids are skipped.
  profilesFor(userIds: string[]): Promise<Map<string, PeopleYouMayKnowSignals & { username: string; display_name: string; profile_pic: string | null; created_at: string | null }>>;
  // The caller's own affinity profile + current city.
  callerSignals(userId: string): Promise<PeopleYouMayKnowSignals>;
  // User ids with privacy_settings.friend_suggestions_enabled = 'false' (opted out).
  suggestionOptOutIds(userIds: string[]): Promise<Set<string>>;
}

export interface PeopleYouMayKnowOptions {
  limit?: number;
  weights?: Partial<PeopleYouMayKnowWeights>;
}

export const EMPTY_SIGNALS: PeopleYouMayKnowSignals = {
  college_id: null,
  company_id: null,
  high_school_id: null,
  current_city: null,
};

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return 20;
  return Math.max(1, Math.min(50, Math.floor(limit)));
}

interface ProfileEntry {
  id: string;
  username: string;
  display_name: string;
  profile_pic: string | null;
  college_id: string | null;
  company_id: string | null;
  high_school_id: string | null;
  created_at: string | null;
}

async function readAll<T>(
  domain: string,
  buildQuery: (client: SupabaseClient) => PromiseLike<{ data: T[] | null }>
): Promise<T[]> {
  const projects = projectManager.getReadableProjects(domain);
  if (projects.length === 0) return [];
  const out: T[] = [];
  for (const entry of projects) {
    try {
      const { data } = await buildQuery(entry.client);
      if (data) out.push(...data);
    } catch {
      // An unreachable/offline host contributes nothing; other hosts still count.
    }
  }
  return out;
}

// The `friends` / `followers` / `profiles` / `blocks` / `groups` /
// `privacy_settings` domains exist when the live infra is registered. When a
// domain is absent (e.g. offline fallback infra) fall back to the `users`
// host, which owns those tables there.
function readableDomain(preferred: string): string {
  if (projectManager.getReadableProjects(preferred).length > 0) return preferred;
  return 'users';
}

export async function computePeopleYouMayKnow(
  callerId: string | undefined,
  options: PeopleYouMayKnowOptions = {},
  deps: PeopleYouMayKnowDeps = defaultDeps
): Promise<PeopleYouMayKnowCandidate[]> {
  if (!callerId) return [];
  const limit = clampLimit(options.limit);
  const weights: PeopleYouMayKnowWeights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };

  try {
    const safe = <T>(promise: Promise<T>, fallback: T): Promise<T> => promise.catch(() => fallback);
    const [related, myAccepted, myFollowing, myFollowers, blocked, myGroups, callerSignals] =
      await Promise.all([
        safe(deps.allRelatedUserIds(callerId), new Set<string>()),
        safe(deps.acceptedFriendIds(callerId), new Set<string>()),
        safe(deps.followingIds(callerId), new Set<string>()),
        safe(deps.followerIds(callerId), new Set<string>()),
        safe(deps.blockedPeerIds(callerId), new Set<string>()),
        safe(deps.groupIdsOf(callerId), new Set<string>()),
        safe(deps.callerSignals(callerId), { ...EMPTY_SIGNALS }),
      ]);

    const counts = new Map<string, CandidateScore>();

    // Mutual accepted friends (exact): for every accepted friend F of mine,
    // every accepted friend of F contributes one mutual-friend point.
    const friendEdges = await safe(deps.acceptedFriendsOf([...myAccepted]), new Map<string, Set<string>>());
    for (const [, friendsOfF] of friendEdges) {
      for (const cand of friendsOfF) {
        if (!cand || cand === callerId) continue;
        const c = counts.get(cand) ?? { mutualFriends: 0, sharedGroups: 0, mutualFollowers: 0 };
        c.mutualFriends += 1;
        counts.set(cand, c);
      }
    }

    // Shared group membership.
    if (myGroups.size > 0) {
      const memberMap = await safe(deps.membersOfGroups([...myGroups]), new Map<string, Set<string>>());
      for (const [, members] of memberMap) {
        for (const m of members) {
          if (!m || m === callerId) continue;
          const c = counts.get(m) ?? { mutualFriends: 0, sharedGroups: 0, mutualFollowers: 0 };
          c.sharedGroups += 1;
          counts.set(m, c);
        }
      }
    }

    // Follow reach + mutual followers: one batched read over people I follow OR
    // people who follow me, then count who ALSO follows each candidate.
    if (myFollowing.size > 0 || myFollowers.size > 0) {
      const followKeys = new Set([...myFollowing, ...myFollowers]);
      const followMap = await safe(deps.followedBy([...followKeys]), new Map<string, Set<string>>());
      const followReach = new Map<string, number>();
      const mutualFollowers = new Map<string, number>();
      for (const follower of myFollowing) {
        for (const cand of followMap.get(follower) ?? []) {
          if (!cand || cand === callerId || myFollowers.has(cand)) continue;
          followReach.set(cand, (followReach.get(cand) ?? 0) + 1);
        }
      }
      for (const follower of myFollowers) {
        for (const cand of followMap.get(follower) ?? []) {
          if (!cand || cand === callerId) continue;
          mutualFollowers.set(cand, (mutualFollowers.get(cand) ?? 0) + 1);
        }
      }
      const all = new Set([...followReach.keys(), ...mutualFollowers.keys()]);
      for (const cand of all) {
        const c = counts.get(cand) ?? { mutualFriends: 0, sharedGroups: 0, mutualFollowers: 0 };
        c.mutualFollowers += (mutualFollowers.get(cand) ?? 0) + (followReach.get(cand) ?? 0);
        counts.set(cand, c);
      }
    }

    // Exclude: self (safety), any friends row (all statuses), blocked (both
    // directions), and everyone the caller already follows.
    const candidateIds = [...counts.keys()].filter(
      (id) => id !== callerId && !related.has(id) && !blocked.has(id) && !myFollowing.has(id)
    );
    if (candidateIds.length === 0) return [];

    const [profiles, optOutIds] = await Promise.all([
      safe(deps.profilesFor(candidateIds), new Map()),
      safe(deps.suggestionOptOutIds(candidateIds), new Set<string>()),
    ]);

    const candidates: PeopleYouMayKnowCandidate[] = [];
    for (const id of candidateIds) {
      const profile = profiles.get(id);
      if (!profile) continue; // no profiles row -> deleted/deactivated -> never suggested
      if (optOutIds.has(id)) continue;
      const c = counts.get(id)!;
      const sameCollege = !!(callerSignals.college_id && profile.college_id && profile.college_id === callerSignals.college_id);
      const sameCompany = !!(callerSignals.company_id && profile.company_id && profile.company_id === callerSignals.company_id);
      const sameHighSchool = !!(callerSignals.high_school_id && profile.high_school_id && profile.high_school_id === callerSignals.high_school_id);
      const sameCity =
        !!callerSignals.current_city &&
        !!profile.current_city &&
        callerSignals.current_city.trim().toLowerCase() === profile.current_city.trim().toLowerCase();
      const score = scoreCandidate(
        {
          mutualFriendsCount: c.mutualFriends,
          sharedGroupsCount: c.sharedGroups,
          mutualFollowersCount: c.mutualFollowers,
          sameCollege,
          sameCompany,
          sameHighSchool,
          sameCity,
        },
        weights
      );
      candidates.push({
        id,
        username: profile.username,
        display_name: profile.display_name,
        profile_pic: profile.profile_pic,
        mutual_friends_count: c.mutualFriends,
        mutual_groups_count: c.sharedGroups,
        mutual_followers_count: c.mutualFollowers,
        same_college: sameCollege,
        same_company: sameCompany,
        same_high_school: sameHighSchool,
        same_city: sameCity,
        score,
        created_at: profile.created_at,
      });
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.mutual_friends_count !== a.mutual_friends_count) return b.mutual_friends_count - a.mutual_friends_count;
      if (b.mutual_groups_count !== a.mutual_groups_count) return b.mutual_groups_count - a.mutual_groups_count;
      if (b.created_at !== a.created_at) return (b.created_at ?? '').localeCompare(a.created_at ?? '');
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return selectDiverse(candidates, limit, weights);
  } catch {
    return [];
  }
}

export const defaultDeps: PeopleYouMayKnowDeps = {
  async allRelatedUserIds(userId) {
    try {
      const domain = readableDomain('friends');
      const rows = await readAll<{ requester_id?: string; receiver_id?: string }>(domain, (c) =>
        c.from('friends').select('requester_id, receiver_id').or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
      );
      const ids = new Set<string>();
      for (const f of rows) {
        const other = f.requester_id === userId ? f.receiver_id : f.requester_id;
        if (typeof other === 'string' && other !== userId) ids.add(other);
      }
      return ids;
    } catch {
      return new Set<string>();
    }
  },
  async acceptedFriendIds(userId) {
    try {
      const domain = readableDomain('friends');
      const rows = await readAll<{ requester_id?: string; receiver_id?: string; status?: string }>(domain, (c) =>
        c.from('friends').select('requester_id, receiver_id, status').or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
      );
      const ids = new Set<string>();
      for (const f of rows) {
        if (!f || f.status !== 'accepted') continue;
        const other = f.requester_id === userId ? f.receiver_id : f.requester_id;
        if (typeof other === 'string' && other !== userId) ids.add(other);
      }
      return ids;
    } catch {
      return new Set<string>();
    }
  },
  async acceptedFriendsOf(userIds) {
    const map = new Map<string, Set<string>>();
    if (userIds.length === 0) return map;
    const queried = new Set(userIds);
    try {
      const domain = readableDomain('friends');
      const [lhs, rhs] = await Promise.all([
        readAll<{ requester_id?: string; receiver_id?: string; status?: string }>(domain, (c) =>
          c.from('friends').select('requester_id, receiver_id, status').in('requester_id', userIds)
        ),
        readAll<{ requester_id?: string; receiver_id?: string; status?: string }>(domain, (c) =>
          c.from('friends').select('requester_id, receiver_id, status').in('receiver_id', userIds)
        ),
      ]);
      for (const f of [...lhs, ...rhs]) {
        if (!f || f.status !== 'accepted' || typeof f.requester_id !== 'string' || typeof f.receiver_id !== 'string') continue;
        if (!map.has(f.requester_id)) map.set(f.requester_id, new Set<string>());
        if (!map.has(f.receiver_id)) map.set(f.receiver_id, new Set<string>());
        if (queried.has(f.requester_id)) map.get(f.requester_id)!.add(f.receiver_id);
        if (queried.has(f.receiver_id)) map.get(f.receiver_id)!.add(f.requester_id);
      }
    } catch {
      // Batched graph read failure -> empty graph (caller never throws).
    }
    return map;
  },
  async followingIds(userId) {
    try {
      const domain = readableDomain('followers');
      const rows = await readAll<{ following_id?: string }>(domain, (c) =>
        c.from('followers').select('following_id').eq('follower_id', userId)
      );
      return new Set(rows.map((r) => r.following_id).filter((s): s is string => typeof s === 'string'));
    } catch {
      return new Set<string>();
    }
  },
  async followerIds(userId) {
    try {
      const domain = readableDomain('followers');
      const rows = await readAll<{ follower_id?: string }>(domain, (c) =>
        c.from('followers').select('follower_id').eq('following_id', userId)
      );
      return new Set(rows.map((r) => r.follower_id).filter((s): s is string => typeof s === 'string'));
    } catch {
      return new Set<string>();
    }
  },
  async followedBy(followerIds) {
    const map = new Map<string, Set<string>>();
    if (followerIds.length === 0) return map;
    try {
      const domain = readableDomain('followers');
      const rows = await readAll<{ follower_id?: string; following_id?: string }>(domain, (c) =>
        c.from('followers').select('follower_id, following_id').in('follower_id', followerIds)
      );
      for (const r of rows) {
        if (!r || typeof r.follower_id !== 'string' || typeof r.following_id !== 'string') continue;
        if (!map.has(r.follower_id)) map.set(r.follower_id, new Set<string>());
        map.get(r.follower_id)!.add(r.following_id);
      }
    } catch {
      // Empty follow map -> no follow-based candidates.
    }
    return map;
  },
  async blockedPeerIds(userId) {
    try {
      const domain = readableDomain('blocking');
      const rows = await readAll<{ blocker_id?: string; blocked_id?: string }>(domain, (c) =>
        c.from('blocks').select('blocker_id, blocked_id').or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`)
      );
      const ids = new Set<string>();
      for (const r of rows) {
        if (r.blocker_id === userId && typeof r.blocked_id === 'string') ids.add(r.blocked_id);
        if (r.blocked_id === userId && typeof r.blocker_id === 'string') ids.add(r.blocker_id);
      }
      return ids;
    } catch {
      return new Set<string>();
    }
  },
  async groupIdsOf(userId) {
    try {
      const domain = readableDomain('groups');
      const rows = await readAll<{ group_id?: string }>(domain, (c) =>
        c.from('group_members').select('group_id').eq('user_id', userId)
      );
      return new Set(rows.map((r) => r.group_id).filter((s): s is string => typeof s === 'string'));
    } catch {
      return new Set<string>();
    }
  },
  async membersOfGroups(groupIds) {
    const map = new Map<string, Set<string>>();
    if (groupIds.length === 0) return map;
    try {
      const domain = readableDomain('groups');
      const rows = await readAll<{ group_id?: string; user_id?: string }>(domain, (c) =>
        c.from('group_members').select('group_id, user_id').in('group_id', groupIds)
      );
      for (const r of rows) {
        if (!r || typeof r.group_id !== 'string' || typeof r.user_id !== 'string') continue;
        if (!map.has(r.group_id)) map.set(r.group_id, new Set<string>());
        map.get(r.group_id)!.add(r.user_id);
      }
    } catch {
      // Empty membership map -> no group-based candidates.
    }
    return map;
  },
  async profilesFor(userIds) {
    const map = new Map<string, PeopleYouMayKnowSignals & ProfileEntry>();
    if (userIds.length === 0) return map;
    try {
      const profileDomain = readableDomain('profiles');
      const rows = await readAll<ProfileEntry>(profileDomain, (c) =>
        c.from('profiles').select('id, username, display_name, profile_pic, college_id, company_id, high_school_id, created_at').in('id', userIds)
      );
      for (const p of rows) {
        if (!p || typeof p.id !== 'string') continue;
        map.set(p.id, {
          id: p.id,
          username: p.username,
          display_name: p.display_name,
          profile_pic: p.profile_pic,
          college_id: p.college_id,
          company_id: p.company_id,
          high_school_id: p.high_school_id,
          created_at: p.created_at,
          current_city: null,
        });
      }
      const cityDomain = readableDomain('profile_details');
      const cityRows =
        cityDomain === 'profile_details'
          ? await readAll<{ profile_id?: string; field_value?: string }>(cityDomain, (c) =>
              c.from('profile_details').select('profile_id, field_value').eq('section', 'places').eq('field_name', 'current_city').in('profile_id', userIds)
            )
          : [];
      for (const r of cityRows) {
        const p = r.profile_id ? map.get(r.profile_id) : undefined;
        if (p && typeof r.field_value === 'string') p.current_city = r.field_value;
      }
    } catch {
      // No profiles resolvable -> empty map.
    }
    return map;
  },
  async callerSignals(userId) {
    const signals: PeopleYouMayKnowSignals = { ...EMPTY_SIGNALS };
    try {
      const domain = readableDomain('profiles');
      const rows = await readAll<ProfileEntry>(domain, (c) =>
        c.from('profiles').select('id, username, display_name, profile_pic, college_id, company_id, high_school_id, created_at').eq('id', userId)
      );
      const p = rows.find((r) => r.id === userId);
      if (p) {
        signals.college_id = p.college_id;
        signals.company_id = p.company_id;
        signals.high_school_id = p.high_school_id;
      }
      const cityDomain = readableDomain('profile_details');
      const cityRows =
        cityDomain === 'profile_details'
          ? await readAll<{ profile_id?: string; field_value?: string }>(cityDomain, (c) =>
              c.from('profile_details').select('profile_id, field_value').eq('profile_id', userId).eq('section', 'places').eq('field_name', 'current_city')
            )
          : [];
      const city = cityRows.find((r) => r.field_value);
      if (city && typeof city.field_value === 'string') signals.current_city = city.field_value;
    } catch {
      // Caller signal failure -> empty signals (no same-* bonuses).
    }
    return signals;
  },
  async suggestionOptOutIds(userIds) {
    const ids = new Set<string>();
    if (userIds.length === 0) return ids;
    try {
      const domain = readableDomain('privacy_settings');
      const rows = await readAll<{ user_id?: string }>(domain, (c) =>
        c.from('privacy_settings').select('user_id').eq('setting_name', 'friend_suggestions_enabled').eq('setting_value', 'false').in('user_id', userIds)
      );
      for (const r of rows) {
        if (typeof r.user_id === 'string') ids.add(r.user_id);
      }
    } catch {
      // Opt-out read failure -> treat nobody as opted out (never crashes).
    }
    return ids;
  },
};