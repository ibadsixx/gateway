// "At least one of my accepted friends is currently online", Gateway side
// (do.md "green online-friends indicator on the mobile Messages icon").
//
// WHAT THIS EXISTS TO AVOID. The obvious implementation is a frontend effect in
// the navigation component that reads the caller's accepted friends and their
// `last_seen_at`, and refreshes on a timer. That is precisely the four things
// do.md forbids - a query on every render, a second presence read path, polling,
// and an N+1 over the friend list - and it is also wrong in a way no test
// catches: the navigation component unmounts on route changes, so the indicator
// would be correct only while the user sat on a page that happened to render it.
//
// So the answer is computed where the two facts that define it already live, and
// only the ANSWER crosses the wire. `hasOnlineFriend` is a boolean. The client
// never learns which friend is online, only that somebody is, which is what the
// dot needs and nothing more: the roster would be extra online-status
// information handed to a browser for no gain (do.md, "Privacy and access").
//
// REUSING THE EXISTING SOURCES, none of which are new:
//
//   - `acceptedFriendIds` / `blockedPeerIds` are the gateway's EXISTING
//     accepted-friendship and blocking logic, taken as-is from
//     features/peopleYouMayKnow.ts. The "accepted" filter and the both-directions
//     block rule are therefore literally the same code the "people you may know"
//     feature uses, not a second copy of the relationship rules.
//   - Presence is `profiles.last_seen_at`, the one column every existing dot in
//     the app already reads. There is no `is_online` column and no presence
//     table; nothing here creates one.
//   - Freshness is `PRESENCE_OFFLINE_THRESHOLD_MS` from features/presence.ts,
//     the same window `isOnline()` applies, with its cross-repository drift risk
//     documented at the constant and asserted in the test.
//
// TWO READS, BATCHED, NEVER N+1: one query for the accepted friend ids (rows the
// caller is already party to), then ONE `profiles ... IN (...)` for all of their
// presence stamps. Cost is flat in the number of friends.
//
// WHY `offlineAt` COMES BACK WITH THE BOOLEAN. A boolean cannot express "this is
// true right now", because presence ages out silently: a friend who closes the
// app stops beating, and no event is emitted for that - there is nothing on the
// wire to observe. Without a moment to count down to, the client has exactly two
// options, both of which do.md rejects: poll until it agrees, or leave the dot
// green until some unrelated event happens to cause a re-read. `offlineAt` is the
// EARLIEST instant at which this answer can become false (the soonest online
// friend's stamp plus the freshness window), so the client arms ONE timeout for
// it and re-reads when it fires. Still no polling, still no roster.
//
// THE OTHER HALF IS THE WAKE-UP. `publishPresenceToFriends` is what makes "friend
// A comes online" appear promptly: it fans a payload-free `presence.updated` out
// to each accepted friend's own `user:<id>` realtime channel, which is the channel
// every client already holds open. Two things keep that cheap, and both are load
// bearing:
//
//   1. It only runs on a TRANSITION. The steady state - a user beating every 30
//      seconds while they sit and chat - publishes nothing at all, because the
//      caller was already fresh. The cost of an unconditional fan-out would be
//      O(friends) broadcasts per heartbeat, per user, forever.
//   2. The payload is EMPTY. A wake-up tells the reader "re-read the boolean",
//      and nothing about who or how many. If this ever leaked an id it would
//      become the roster disclosure this module exists to avoid.
//
// The one price is a primary-key read of the CALLER'S OWN row before the
// transition can be judged (see `publishPresenceToFriends`), on the same 30-second
// heartbeat that already writes that row. One indexed lookup is the cheap way to
// avoid a broadcast to every friend every 30 seconds; the alternative, trusting a
// client-supplied "I just came online" flag, would let any account spray its
// friends with wake-ups.

import { PRESENCE_LOGGED_OUT_AT, PRESENCE_OFFLINE_THRESHOLD_MS } from './presence';
import { defaultDeps as peopleYouMayKnowDeps } from './peopleYouMayKnow';
import { projectManager } from '../project-manager';
import { channelHub } from '../realtime/channelHub';

/**
 * The event name. `presence.updated` rather than something friend-specific: it
 * carries no payload, so the name describes the only thing it tells the reader -
 * that its cached answer may now be stale.
 */
export const PRESENCE_UPDATED_EVENT = 'presence.updated';

/**
 * Minimal shape of the part of a Supabase client this feature uses. Loosely
 * typed on purpose, matching the convention in `presence.PresenceClient` and the
 * registry clients (whose row types resolve to `never` for an untyped table).
 */
export interface OnlineFriendsClient {
  from(table: string): any;
}

export interface OnlineFriendsDeps {
  /** The other side of every ACCEPTED friendship row involving `userId`. */
  acceptedFriendIds(userId: string): Promise<Set<string>>;
  /** Blocker/blocked peers of `userId`, in BOTH directions. */
  blockedPeerIds(userId: string): Promise<Set<string>>;
  /** `profiles.last_seen_at` for the given ids; missing ids are simply absent. */
  readLastSeenAt(ids: string[]): Promise<Map<string, string | null>>;
  /** Fan an event out on a realtime channel. */
  publish(channel: string, event: string, payload: unknown): void;
}

export type OnlineFriendsStatus =
  /**
   * `offlineAt` is the earliest instant this can become false - the soonest
   * online friend's stamp plus the freshness window - or null when nothing is
   * online (and therefore nothing to count down to).
   */
  | { status: 'ok'; hasOnlineFriend: boolean; offlineAt: string | null }
  /** A project accepted the request and the read itself failed. */
  | { status: 'failed'; message: string };

export type PresenceFanoutOutcome =
  /** The caller was already fresh, so there is nothing new to announce. */
  | { status: 'skipped' }
  /** The caller had just come online and this many friends were woken. */
  | { status: 'published'; friendIds: number }
  /** No verified subject, so no fan-out can be attributed to anyone. */
  | { status: 'no-subject' };

export const defaultOnlineFriendsDeps: OnlineFriendsDeps = {
  // The gateway's existing accepted-friendship and blocking rules, shared rather
  // than restated: this module must never disagree with the feature that already
  // decides who counts as a friend or who counts as blocked.
  acceptedFriendIds: (userId) => peopleYouMayKnowDeps.acceptedFriendIds(userId),
  blockedPeerIds: (userId) => peopleYouMayKnowDeps.blockedPeerIds(userId),
  async readLastSeenAt(ids) {
    const stamps = new Map<string, string | null>();
    if (ids.length === 0) return stamps;
    // ONE query for the whole set. Profiles live on their own host, so this is a
    // separate read from the friends query above, and it is batched precisely so
    // that a user with 400 friends costs the same as a user with 4.
    for (const entry of projectManager.getReadableProjects('profiles')) {
      try {
        const { data, error } = await entry.client
          .from('profiles')
          .select('id, last_seen_at')
          .in('id', ids);
        if (error) continue;
        for (const row of (data as Array<{ id?: unknown; last_seen_at?: unknown }>) ?? []) {
          if (typeof row?.id !== 'string') continue;
          stamps.set(row.id, typeof row.last_seen_at === 'string' ? row.last_seen_at : null);
        }
        return stamps;
      } catch {
        // Try the next readable project for this host.
      }
    }
    return stamps;
  },
  publish(channel, event, payload) {
    channelHub.publish(channel, event, payload);
  },
};

/**
 * Whether a `last_seen_at` stamp means "here now", as of `nowMs`.
 *
 * The three ways a stamp can be untrustworthy all answer false, which is the only
 * safe direction for an indicator: the logged-out marker (an explicit sign-out
 * that `isOnline()` would otherwise count as fresh forever, because it is a
 * timestamp and not a flag), a future date (clock skew, and the same disagreement
 * `isOnline` resolves this way), and anything unparseable.
 */
export function isPresenceStampOnline(stamp: string | null | undefined, nowMs: number): boolean {
  if (typeof stamp !== 'string' || stamp.length === 0) return false;
  const ms = Date.parse(stamp);
  if (Number.isNaN(ms)) return false;
  // Parsed TIME, never string equality: Postgres renders the marker with a numeric
  // UTC offset rather than the `Z` this module writes, so the two forms of the same
  // instant differ as text.
  if (ms === Date.parse(PRESENCE_LOGGED_OUT_AT)) return false;
  const age = nowMs - ms;
  if (age < 0) return false;
  return age < PRESENCE_OFFLINE_THRESHOLD_MS;
}

/**
 * `hasOnlineFriend` for the verified caller, plus when it can first become false.
 *
 * `userId` MUST be the gateway-verified caller id. This function cannot check
 * that, which is why the route reads it off the authenticated request and never
 * off the body: it decides whose friends and whose presence are in scope, so a
 * body-supplied id would answer "do I have an online friend" for any account.
 */
export async function getOnlineFriendStatus(
  userId: string | undefined,
  deps: OnlineFriendsDeps = defaultOnlineFriendsDeps,
  now: () => Date = () => new Date()
): Promise<OnlineFriendsStatus> {
  if (typeof userId !== 'string' || userId.length === 0) {
    return { status: 'failed', message: 'missing caller id' };
  }

  let friendIds: Set<string>;
  let blocked: Set<string>;
  try {
    const [friends, blockedPeers] = await Promise.all([
      deps.acceptedFriendIds(userId),
      deps.blockedPeerIds(userId),
    ]);
    friendIds = friends;
    blocked = blockedPeers;
  } catch (err) {
    return { status: 'failed', message: (err as Error)?.message ?? 'relationship read threw' };
  }

  // A blocked peer is not a friend for this purpose, in BOTH directions: someone
  // who blocked me has no business lighting my nav, and someone I blocked has no
  // business being counted at all. `acceptedFriendIds` already excludes the
  // caller itself, but the check is kept because this function's whole claim is
  // "one of MY friends", and a self-count would be a green dot for being online.
  const candidates = [...friendIds].filter((id) => id !== userId && !blocked.has(id));

  if (candidates.length === 0) {
    return { status: 'ok', hasOnlineFriend: false, offlineAt: null };
  }

  let stamps: Map<string, string | null>;
  try {
    stamps = await deps.readLastSeenAt(candidates);
  } catch (err) {
    return { status: 'failed', message: (err as Error)?.message ?? 'presence read threw' };
  }

  const nowMs = now().getTime();
  let hasOnlineFriend = false;
  let offlineAtMs = Number.POSITIVE_INFINITY;
  for (const id of candidates) {
    const stamp = stamps.get(id) ?? null;
    if (!isPresenceStampOnline(stamp, nowMs)) continue;
    hasOnlineFriend = true;
    // The soonest expiry is the one that decides the countdown: when that friend
    // ages out, the answer may flip, so the client re-reads then - not when some
    // other friend happens to expire later.
    const expiry = Date.parse(stamp as string) + PRESENCE_OFFLINE_THRESHOLD_MS;
    if (expiry < offlineAtMs) offlineAtMs = expiry;
  }

  return {
    status: 'ok',
    hasOnlineFriend,
    offlineAt: hasOnlineFriend && Number.isFinite(offlineAtMs)
      ? new Date(offlineAtMs).toISOString()
      : null,
  };
}

/**
 * The caller's own `last_seen_at` as it stands NOW, i.e. before this heartbeat's
 * write. One primary-key read.
 *
 * It has to be sampled separately, and before the write, because a transition is
 * only visible in the value the write is about to replace. Reading it afterwards
 * - which is the obvious place to put this call, since that is when there is
 * something to announce - reads a stamp the heartbeat has already refreshed and
 * therefore reports "already online" forever, which silently disables the wake-up
 * while looking correct at every step.
 */
export async function readOwnPresenceStamp(
  userId: string | undefined,
  deps: OnlineFriendsDeps = defaultOnlineFriendsDeps
): Promise<string | null> {
  if (typeof userId !== 'string' || userId.length === 0) return null;
  try {
    const own = await deps.readLastSeenAt([userId]);
    return own.get(userId) ?? null;
  } catch {
    // An unreadable previous stamp is treated as "there was no previous stamp",
    // which errs towards announcing: a redundant wake-up costs the reader one
    // request, while a missing one leaves a friend online with no dot.
    return null;
  }
}

/**
 * Announce that the caller has just come online, to each of their accepted
 * friends, exactly once per transition.
 *
 * `previousStamp` MUST be the caller's own stamp from BEFORE this heartbeat's
 * write (see `readOwnPresenceStamp`, which is why it is a parameter rather than
 * something this reads for itself). Call this only once the write has SUCCEEDED:
 * publishing before the stamp lands means the woken reader can re-read the old
 * value, find nobody online, and then never hear about that friend again until
 * they go offline and come back.
 *
 * The freshness guard is the whole point: a user sitting in the app beats every
 * `POLL_INTERVAL_MS`, and only the FIRST of those beats - the one that follows a
 * stale or absent stamp - is a transition. Every later beat returns `skipped`
 * without touching the friends list or the hub, so the steady state costs one
 * primary-key read and zero broadcasts.
 *
 * Never rejects: a failed wake-up must not turn a successful heartbeat into a
 * failed one. The cost of missing it is bounded and self-healing - the reader
 * re-reads on its own `offlineAt`, on tab focus, and on realtime reconnect - so
 * there is nothing here worth failing a presence write over.
 */
export async function publishPresenceToFriends(
  userId: string | undefined,
  previousStamp: string | null,
  deps: OnlineFriendsDeps = defaultOnlineFriendsDeps,
  now: () => Date = () => new Date()
): Promise<PresenceFanoutOutcome> {
  if (typeof userId !== 'string' || userId.length === 0) return { status: 'no-subject' };

  try {
    if (isPresenceStampOnline(previousStamp, now().getTime())) return { status: 'skipped' };

    const [friends, blocked] = await Promise.all([
      deps.acceptedFriendIds(userId),
      deps.blockedPeerIds(userId),
    ]);
    let sent = 0;
    for (const friendId of friends) {
      if (friendId === userId || blocked.has(friendId)) continue;
      // One channel per recipient: `user:<id>` is the only channel a client may
      // subscribe to (api/realtime.ts enforces that it is its own), which is why
      // this needs no new subscription on the reader and no new channel namespace.
      deps.publish(`user:${friendId}`, PRESENCE_UPDATED_EVENT, {});
      sent++;
    }
    return { status: 'published', friendIds: sent };
  } catch {
    return { status: 'skipped' };
  }
}
