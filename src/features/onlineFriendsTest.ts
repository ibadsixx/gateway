// do.md "green online-friends indicator on the mobile Messages icon",
// Gateway side.
//
// The claim under test is narrow and falsifiable: "at least one of MY ACCEPTED
// FRIENDS is currently online", and nothing else lights the dot. Everything here
// is arranged around the ways that claim goes quietly wrong rather than loudly.
//
// Asserted, in order:
//
//   1. FRESHNESS. A stamp counts only inside the window `isOnline()` uses, and the
//      three untrustworthy stamps - the explicit sign-out marker, a future date,
//      and an unparseable string - all count as OFFLINE. Getting any of those
//      wrong means a green dot on somebody who left.
//   2. THE FRIENDSHIP RULE. Pending, rejected and blocked people do not count, and
//      neither does the caller. The friendship and block sets are INJECTED, so
//      this also pins the contract that they arrive already filtered by the
//      gateway's existing accepted-friendship logic rather than re-filtered here.
//   3. NO ROSTER. The response is a boolean and a timestamp. There is no
//      per-friend field anywhere in it, because a browser that learns which friend
//      is online has been handed more presence information than a nav dot needs.
//   4. `offlineAt` IS THE SOONEST EXPIRY, not the latest. This is the field that
//      replaces polling: the client arms one timeout for it, so a value pointing
//      at the wrong moment either keeps a stale dot up or re-reads for nothing.
//   5. NO N+1. One presence read for the whole friend set, however many friends.
//   6. THE WAKE-UP ONLY FIRES ON A TRANSITION. Publishing on every heartbeat would
//      be O(friends) broadcasts per user per interval forever; publishing when the
//      previous stamp was already fresh is the difference between zero and all of
//      them. The payload must be empty - it is a wake-up, not an announcement.
//   7. IDENTITY. Both routes take the caller id from the verified request, and the
//      heartbeat samples the pre-write stamp BEFORE writing and fans out AFTER.
//      The ordering is the whole mechanism: sample it after, or publish it before,
//      and the wake-up is permanently dead while every step still looks correct.
//
// Run: npm run test:online-friends
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'path';

import {
  PRESENCE_UPDATED_EVENT,
  getOnlineFriendStatus,
  isPresenceStampOnline,
  publishPresenceToFriends,
  readOwnPresenceStamp,
  type OnlineFriendsDeps,
} from './onlineFriends';
import { PRESENCE_LOGGED_OUT_AT, PRESENCE_OFFLINE_THRESHOLD_MS } from './presence';

const ME = 'me-1';
const FRIEND = 'friend-1';
const OTHER_FRIEND = 'friend-2';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const ago = (ms: number) => new Date(NOW_MS - ms).toISOString();

interface Recorded {
  publish: Array<{ channel: string; event: string; payload: unknown }>;
  presenceReads: string[][];
  friendQueries: string[];
}

function harness(
  opts: {
    friends?: Set<string>;
    blocked?: Set<string>;
    stamps?: Record<string, string | null>;
    friendsThrows?: boolean;
    blockedThrows?: boolean;
    stampsThrows?: boolean;
    publishThrows?: boolean;
  } = {}
): { deps: OnlineFriendsDeps; rec: Recorded } {
  const rec: Recorded = { publish: [], presenceReads: [], friendQueries: [] };
  const deps: OnlineFriendsDeps = {
    async acceptedFriendIds(userId) {
      rec.friendQueries.push(userId);
      if (opts.friendsThrows) throw new Error('friends host down');
      return opts.friends ?? new Set<string>();
    },
    async blockedPeerIds() {
      if (opts.blockedThrows) throw new Error('blocking host down');
      return opts.blocked ?? new Set<string>();
    },
    async readLastSeenAt(ids) {
      rec.presenceReads.push(ids);
      if (opts.stampsThrows) throw new Error('profiles host down');
      const out = new Map<string, string | null>();
      for (const id of ids) out.set(id, opts.stamps?.[id] ?? null);
      return out;
    },
    publish(channel, event, payload) {
      if (opts.publishThrows) throw new Error('hub down');
      rec.publish.push({ channel, event, payload });
    },
  };
  return { deps, rec };
}

async function main(): Promise<void> {
  const now = () => NOW;

  // -------------------------------------------------------------------------
  // 1. Freshness, and the three stamps that must read as offline.
  // -------------------------------------------------------------------------
  assert.equal(isPresenceStampOnline(ago(1000), NOW_MS), true, 'a beat a second ago is online');
  assert.equal(
    isPresenceStampOnline(ago(PRESENCE_OFFLINE_THRESHOLD_MS - 1000), NOW_MS),
    true,
    'just inside the window is online'
  );
  assert.equal(
    isPresenceStampOnline(ago(PRESENCE_OFFLINE_THRESHOLD_MS), NOW_MS),
    false,
    'exactly at the threshold is offline, so the dot cannot outlive the window'
  );
  assert.equal(isPresenceStampOnline(ago(PRESENCE_OFFLINE_THRESHOLD_MS + 1), NOW_MS), false);
  assert.equal(
    isPresenceStampOnline(PRESENCE_LOGGED_OUT_AT, NOW_MS),
    false,
    'an explicit sign-out must not count as a fresh heartbeat'
  );
  // Postgres renders the marker with a numeric UTC offset rather than the `Z` the
  // writer sends, so the two spellings of one instant must agree.
  assert.equal(
    isPresenceStampOnline('1970-01-01T00:00:00+00:00', NOW_MS),
    false,
    'the marker is matched by parsed time, never by string'
  );
  assert.equal(isPresenceStampOnline(new Date(NOW_MS + 60_000).toISOString(), NOW_MS), false, 'clock skew');
  assert.equal(isPresenceStampOnline('not-a-date', NOW_MS), false);
  assert.equal(isPresenceStampOnline(null, NOW_MS), false);
  assert.equal(isPresenceStampOnline(undefined, NOW_MS), false);
  assert.equal(isPresenceStampOnline('', NOW_MS), false);

  // -------------------------------------------------------------------------
  // 2 + 3 + 4 + 5. One friend online: true, one soonest expiry, one batched read,
  //    and nothing that names the friend.
  // -------------------------------------------------------------------------
  {
    const { deps, rec } = harness({
      friends: new Set([FRIEND, OTHER_FRIEND]),
      stamps: {
        // FRIEND beat 10s ago -> expires in (threshold - 10s)
        [FRIEND]: ago(10_000),
        // OTHER_FRIEND beat 40s ago -> expires SOONER
        [OTHER_FRIEND]: ago(40_000),
        [ME]: ago(5_000),
      },
    });
    const out = await getOnlineFriendStatus(ME, deps, now);
    assert.equal(out.status, 'ok');
    assert.equal(out.status === 'ok' && out.hasOnlineFriend, true);

    const expected = new Date(
      Date.parse(ago(40_000)) + PRESENCE_OFFLINE_THRESHOLD_MS
    ).toISOString();
    assert.equal(
      out.status === 'ok' ? out.offlineAt : null,
      expected,
      'the countdown must point at the friend who ages out FIRST, not the last'
    );

    assert.deepEqual(rec.friendQueries, [ME], 'the caller id is what the friendship read is keyed on');
    assert.equal(rec.presenceReads.length, 1, 'one presence read for the whole friend set');
    assert.deepEqual(
      [...rec.presenceReads[0]].sort(),
      [FRIEND, OTHER_FRIEND],
      'a batched read of exactly the friend ids - no N+1, and no read for the caller'
    );
  }

  {
    // Nothing online: false and null. A null `offlineAt` is what tells the client
    // there is no countdown to arm at all.
    const { deps, rec } = harness({
      friends: new Set([FRIEND]),
      stamps: { [FRIEND]: ago(PRESENCE_OFFLINE_THRESHOLD_MS + 60_000), [ME]: ago(1000) },
    });
    const out = await getOnlineFriendStatus(ME, deps, now);
    assert.equal(out.status === 'ok' && out.hasOnlineFriend, false);
    assert.equal(out.status === 'ok' ? out.offlineAt : 'x', null);
  }

  {
    // No friends at all: the friendship rule is consulted, and there is no reason
    // to read presence for nobody.
    const { deps, rec } = harness({ friends: new Set<string>() });
    const out = await getOnlineFriendStatus(ME, deps, now);
    assert.equal(out.status === 'ok' && out.hasOnlineFriend, false);
    assert.equal(rec.presenceReads.length, 0, 'an empty friend set must not cost a presence read');
  }

  // -------------------------------------------------------------------------
  // 2. Who does not count.
  // -------------------------------------------------------------------------
  {
    // A blocked peer who is online, and only a blocked peer.
    const { deps, rec } = harness({
      friends: new Set([FRIEND]),
      blocked: new Set([FRIEND]),
      stamps: { [FRIEND]: ago(1000) },
    });
    const out = await getOnlineFriendStatus(ME, deps, now);
    assert.equal(
      out.status === 'ok' && out.hasOnlineFriend,
      false,
      'a blocked peer must not light the dot, in either direction of the block'
    );
    assert.equal(rec.presenceReads.length, 0, 'a blocked peer is dropped before it is read');
  }

  {
    // Blocked AND unbatched: the blocked friend is removed but the good ones are
    // still read together.
    const { deps, rec } = harness({
      friends: new Set([FRIEND, OTHER_FRIEND]),
      blocked: new Set([OTHER_FRIEND]),
      stamps: { [FRIEND]: ago(1000), [OTHER_FRIEND]: ago(1000) },
    });
    const out = await getOnlineFriendStatus(ME, deps, now);
    assert.equal(out.status === 'ok' && out.hasOnlineFriend, true);
    assert.deepEqual(rec.presenceReads[0], [FRIEND]);
  }

  {
    // The caller appearing in the friend set is a data-shape accident, not a
    // reason to be green at yourself.
    const { deps } = harness({ friends: new Set([ME]), stamps: { [ME]: ago(1000) } });
    const out = await getOnlineFriendStatus(ME, deps, now);
    assert.equal(
      out.status === 'ok' && out.hasOnlineFriend,
      false,
      'being online is not "a friend is online"'
    );
  }

  {
    // The contract with the injected friendship source: it receives the caller and
    // is trusted to have applied the accepted-status filter. A pending sender and a
    // blocked user are simply absent from that set, which is why this module never
    // filters on status itself.
    const { deps, rec } = harness({ friends: new Set([FRIEND]), stamps: { [FRIEND]: ago(1000) } });
    await getOnlineFriendStatus(ME, deps, now);
    assert.deepEqual(
      rec.friendQueries,
      [ME],
      'friendship is decided by the existing accepted-friendship logic, keyed on the caller'
    );
  }

  // -------------------------------------------------------------------------
  // 6. Failures stay distinguishable, and never read as "nobody is online".
  // -------------------------------------------------------------------------
  for (const bad of ['', undefined, null as unknown as string]) {
    const { deps, rec } = harness({ friends: new Set([FRIEND]) });
    const out = await getOnlineFriendStatus(bad, deps, now);
    assert.equal(out.status, 'failed', `caller id ${JSON.stringify(bad)} must be refused`);
    assert.equal(rec.friendQueries.length, 0, 'a refused read must not query anything');
  }

  {
    const { deps } = harness({ friendsThrows: true });
    const out = await getOnlineFriendStatus(ME, deps, now);
    assert.equal(out.status, 'failed', 'an unreadable friend list is a failure, not "no friends"');
  }

  {
    const { deps } = harness({ friends: new Set([FRIEND]), stampsThrows: true });
    const out = await getOnlineFriendStatus(ME, deps, now);
    assert.equal(out.status, 'failed', 'an unreadable presence read is a failure, not "nobody online"');
  }

  // -------------------------------------------------------------------------
  // 7. The wake-up, and the transition guard that makes it affordable.
  // -------------------------------------------------------------------------
  {
    const { deps, rec } = harness({ friends: new Set([FRIEND, OTHER_FRIEND]) });
    const out = await publishPresenceToFriends(ME, ago(1000), deps, now);
    assert.equal(out.status, 'skipped', 'a heartbeat that follows a fresh one announces nothing');
    assert.equal(rec.publish.length, 0, 'the steady state must cost zero broadcasts');
    assert.equal(rec.friendQueries.length, 0, 'and must not even read the friend list');
  }

  {
    const { deps, rec } = harness({
      friends: new Set([FRIEND, OTHER_FRIEND]),
      blocked: new Set([OTHER_FRIEND]),
    });
    const out = await publishPresenceToFriends(ME, ago(PRESENCE_OFFLINE_THRESHOLD_MS + 1), deps, now);
    assert.equal(out.status, 'published');
    assert.equal(out.status === 'published' && out.friendIds, 1);
    assert.deepEqual(
      rec.publish,
      [{ channel: `user:${FRIEND}`, event: PRESENCE_UPDATED_EVENT, payload: {} }],
      'one empty wake-up on each friend\'s OWN user channel, which is the channel every ' +
        'client already holds open; blocked peers are not woken'
    );
  }

  {
    // Never been seen before: no previous stamp at all is still a transition.
    const { deps, rec } = harness({ friends: new Set([FRIEND]) });
    const out = await publishPresenceToFriends(ME, null, deps, now);
    assert.equal(out.status === 'published' && out.friendIds, 1);
    assert.equal(rec.publish.length, 1);
  }

  {
    // Signed out and now back: the marker is stale, so this is a fresh arrival.
    const { deps } = harness({ friends: new Set([FRIEND]) });
    const out = await publishPresenceToFriends(ME, PRESENCE_LOGGED_OUT_AT, deps, now);
    assert.equal(out.status === 'published' && out.friendIds, 1);
  }

  {
    const { deps, rec } = harness({ friends: new Set([FRIEND]) });
    const out = await publishPresenceToFriends(undefined, null, deps, now);
    assert.equal(out.status, 'no-subject', 'no verified subject means no fan-out');
    assert.equal(rec.publish.length, 0);
  }

  {
    // A broken hub must not surface as a rejected promise the heartbeat would have
    // to catch: a missed wake-up is cheaper than a failed presence write.
    const { deps } = harness({ friends: new Set([FRIEND]), publishThrows: true });
    const out = await publishPresenceToFriends(ME, null, deps, now);
    assert.equal(out.status, 'skipped');
  }

  {
    const { deps } = harness({ friendsThrows: true });
    const out = await publishPresenceToFriends(ME, null, deps, now);
    assert.equal(out.status, 'skipped');
  }

  // -------------------------------------------------------------------------
  // 8. The pre-write sample is the mechanism, so it is pinned on its own.
  // -------------------------------------------------------------------------
  {
    const { deps, rec } = harness({ stamps: { [ME]: ago(30_000) } });
    const stamp = await readOwnPresenceStamp(ME, deps);
    assert.equal(stamp, ago(30_000), 'the pre-write value is what a transition is judged against');
    assert.deepEqual(rec.presenceReads, [[ME]], 'one primary-key read of the caller\'s own row');
  }

  {
    const { deps } = harness({ stampsThrows: true });
    assert.equal(
      await readOwnPresenceStamp(ME, deps),
      null,
      'an unreadable previous stamp errs towards announcing rather than staying silent'
    );
  }

  assert.equal(await readOwnPresenceStamp(undefined, harness().deps), null);

  // -------------------------------------------------------------------------
  // 9. Cross-repository freshness. The two copies of this window must not drift.
  // -------------------------------------------------------------------------
  {
    const frontend = readFileSync(
      join(__dirname, '..', '..', '..', 'tone-your-social-voice', 'src', 'hooks', 'usePresence.ts'),
      'utf8'
    );
    const declared = /OFFLINE_THRESHOLD_MS\s*=\s*(\d+)/.exec(frontend);
    assert.ok(declared, 'the frontend freshness window must still be declared');
    assert.equal(
      Number(declared![1]),
      PRESENCE_OFFLINE_THRESHOLD_MS,
      'PRESENCE_OFFLINE_THRESHOLD_MS has drifted from `OFFLINE_THRESHOLD_MS` in ' +
        'src/hooks/usePresence.ts: the nav dot would disagree with every other green dot. ' +
        'Change both, or neither.'
    );
  }

  // -------------------------------------------------------------------------
  // 10. Route wiring, including the two orderings that disable the feature.
  // -------------------------------------------------------------------------
  {
    const source = readFileSync(join(__dirname, '..', 'api', 'routes.ts'), 'utf8');

    const online = source.indexOf("router.post('/presence/online-friends'");
    assert.ok(online > -1, 'the gateway must expose the online-friends read');
    const afterOnline = source.slice(online);
    assert.ok(
      afterOnline.indexOf('getOnlineFriendStatus(userId)') > -1,
      'the route must call the feature module'
    );
    assert.ok(
      afterOnline.indexOf('getOnlineFriendStatus(req.user?.id)') === -1,
      'and must never take the caller id from the body'
    );

    const generic = source.indexOf("router.post('/:domain'");
    assert.ok(online > -1 && online < generic, 'the presence route must precede the generic POST');

    // Identity on the new route.
    const onlineBlock = afterOnline.slice(0, afterOnline.indexOf("router.post('/:domain'") === -1
      ? undefined
      : afterOnline.indexOf("router.post('/:domain'"));
    assert.ok(
      onlineBlock.includes('req.user?.id'),
      'the online-friends route must read the verified request identity'
    );
    assert.ok(
      onlineBlock.includes('auth.authenticate'),
      'the online-friends route must require authentication'
    );
    assert.ok(
      /Cache-Control', 'no-store'/.test(onlineBlock),
      'a cached "yes" would pin a green dot on somebody who left'
    );

    // The heartbeat: sample BEFORE the write, fan out AFTER it.
    const hb = source.indexOf("router.post('/presence/heartbeat'");
    assert.ok(hb > -1);
    const hbBlock = source.slice(hb, source.indexOf("router.post('/presence/logout'"));
    const sample = hbBlock.indexOf('readOwnPresenceStamp(userId)');
    const write = hbBlock.indexOf('writePresenceHeartbeat(userId)');
    const fanout = hbBlock.indexOf('publishPresenceToFriends(userId, previousStamp)');
    assert.ok(sample > -1 && write > -1 && fanout > -1, 'all three heartbeat steps must be present');
    assert.ok(
      sample < write,
      'the previous stamp must be sampled BEFORE the write; afterwards it is already ' +
        'fresh and the wake-up can never fire'
    );
    assert.ok(
      write < fanout,
      'the wake-up must follow the write; publishing first means the woken reader re-reads ' +
        'the old value and hears nothing more until that friend leaves and returns'
    );
    assert.ok(
      hbBlock.includes('previousStamp'),
      'the fan-out must receive the sampled stamp, not re-read it'
    );
  }

  console.log('  online-friends: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
