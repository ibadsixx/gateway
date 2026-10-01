// Online presence, Gateway side (do.md "online presence indicator").
//
// This is the WRITE half of Tone's presence store. It is deliberately a thin
// feature module rather than logic inlined in a route, so the write can be
// exercised without an HTTP server and without a database - which matters,
// because the write it replaces had no test and no observable failure.
//
// WHAT WAS BROKEN, and why this file exists at all:
//
//   The presence indicator is `profiles.last_seen_at` compared against a
//   freshness window. The reader is fine - the conversation list fetches
//   `last_seen_at` for its partners on an interval, and the response is not
//   cached, so a fresh value arrives when one exists.
//
//   The WRITER was the broken link, and it was broken in a way that could not be
//   seen. `usePresence` called the database function `update_last_seen()`,
//   which is SECURITY DEFINER and runs
//   `UPDATE profiles SET last_seen_at = NOW() WHERE id = auth.uid()`. Two things
//   about that are fatal, and both fail SILENTLY:
//
//     - `auth.uid()` must resolve inside PostgREST. It is read from the request
//       JWT, so it depends on the users project's own GoTrue accepting the token
//       as well as this gateway's verifier. If it does not resolve, the UPDATE
//       matches zero rows and PostgREST answers 204 - success, having written
//       nothing.
//     - If the function is not present in the deployed database at all, the
//       gateway maps the upstream 404 to 400, and the caller discarded it.
//
//   Measured in production: 28 of 29 profiles had `last_seen_at` exactly equal to
//   `created_at`, which is the column's INSERT default. Nobody had ever been
//   marked online. And because `gateway.rpc()` resolves to `{ data, error }` and
//   the heartbeat ignored `error`, a write path that had never once succeeded was
//   indistinguishable from a user who was simply never online - which is exactly
//   the bug that was reported.
//
//   So the write is moved here, to the one layer that can prove the identity: the
//   gateway already verified the bearer token and holds `req.user.id`, and it
//   already holds a service-role client for the project that hosts `profiles`.
//   Neither fact can drift, and the write no longer depends on auth.uid(), on any
//   database function existing, or on RLS permitting it.
//
// NO SECOND PRESENCE SYSTEM. This writes the same `profiles.last_seen_at` column
// the UI already read, on the same interval, and it replaces the previous writer
// rather than running beside it. There is no `is_online` column, no separate
// presence table, and no second heartbeat; the dot in the conversation list, the
// ChatWindow header and the group-chat online count all continue to derive from
// this one value, which is also why repairing the writer repaired all of them.
//
// LOGOUT. The heartbeat answers "is this user here now", which it can only answer
// by freshness. It cannot answer "did this user just leave", because leaving and
// staying look identical in a timestamp until the freshness window expires. So an
// explicit sign-out used to be invisible: the row kept the timestamp from the
// heartbeat up to one interval earlier, `isOnline()` kept answering true for the
// whole window, and other users saw a green dot on somebody who had signed out.
// See `PRESENCE_LOGGED_OUT_AT` and `writePresenceLogout`.

import { projectManager } from '../project-manager';

export const PRESENCE_PROFILE_DOMAINS = ['profiles', 'users'] as const;

/**
 * The value `last_seen_at` is set to when a user explicitly logs out.
 *
 * WHY A CONSTANT AND NOT `NULL`, which is the obvious choice and is wrong here
 * for two independent reasons:
 *
 *   - The reader refuses to propagate a null. `useConversations` keeps a partner's
 *     existing value when the server sends none, because that is the shape the
 *     gateway returns for a partner whose presence it REDACTED - a non-friend with
 *     a pending message request. A null written by logout is indistinguishable
 *     from that redaction and is dropped on the floor, so the dot would stay
 *     green until the freshness window expired: the bug, unchanged.
 *   - `NULL` is also what `formatLastSeen` renders as the literal string
 *     "Offline", so it would silently discard the user's real last-seen time.
 *
 * WHY NOT A BACKDATED TIMESTAMP (`now - threshold - margin`), which preserves
 * last-seen precision: that couples the writer to the reader's
 * `OFFLINE_THRESHOLD_MS`, which lives in a different repository. Raise the
 * threshold past the margin and explicit logout silently stops working - the same
 * class of invisible failure this module was written to eliminate, and one that
 * would take a production incident to notice.
 *
 * The Unix epoch is used because it is the one instant that is unambiguously "not
 * now", so the marker cannot rot as the reader's threshold is tuned: it is stale
 * under any freshness window below its own age (~56 years), where a backdated
 * value would go stale only while the threshold stayed below a margin chosen in
 * another repository. It also round-trips - Postgres renders `TIMESTAMPTZ` as
 * `1970-01-01T00:00:00+00:00`, which `Date.parse` still yields exactly 0 for, so
 * the frontend matches it by PARSED TIME and never by string. See
 * `isLoggedOutPresence` in `src/hooks/usePresence.ts`, which must recognise the
 * same instant.
 */
export const PRESENCE_LOGGED_OUT_AT = '1970-01-01T00:00:00.000Z';

/**
 * How stale a `last_seen_at` may be and still mean "this user is here now".
 *
 * WHY IT LIVES HERE, which is where it is most likely to be wrong: the value
 * that actually decides whether a dot is green is `isOnline()` in
 * `src/hooks/usePresence.ts` (a different repository), and this constant is a
 * COPY of the threshold inside it, for the two reads the gateway has to make on
 * its own — deciding whether a heartbeat is an offline->online TRANSITION
 * (features/onlineFriends.ts, which is what makes the mobile online-friends dot
 * appear without polling), and answering the "is any accepted friend online"
 * boolean for that same dot.
 *
 * It was deliberately not left as "whatever the reader decides": the two
 * endpoints here cannot import the frontend's constant, and a reader-side-only
 * implementation would have to publish the whole online-friend roster to the
 * browser so the client could apply `isOnline()` itself, which is precisely the
 * "expose additional online-status information to the client" that this feature
 * is meant to avoid.
 *
 * The cost of the copy is that the two repositories can drift: raise
 * `OFFLINE_THRESHOLD_MS` in `src/hooks/usePresence.ts` without raising this and
 * a friend stays green in the conversation list for longer than the nav dot
 * says. The value is therefore asserted to be identical in
 * `features/onlineFriendsTest.ts`, which fails the build if either side changes
 * alone. The `PRESENCE_LOGGED_OUT_AT` note above applies here too and is the
 * reason the marker is an absolute instant rather than a backdated one.
 */
export const PRESENCE_OFFLINE_THRESHOLD_MS = 150000;

/**
 * Minimal shape of the part of a Supabase client this uses. Loosely typed on
 * purpose, matching the same convention as `profileIndexing.ProfileIndexingProject`:
 * the gateway's registry hands back a client whose row types resolve to `never`
 * for an untyped table, and a cast at every call site would be worse than one
 * narrow interface here.
 */
export interface PresenceClient {
  from(table: string): any;
}

export interface PresenceWriteDeps {
  /**
   * A service-role client for `domain`, or null when no project can accept a
   * write there. Injectable so a test can distinguish "no writable project
   * registered" from "the write was rejected", which are different deployment
   * problems and should not share a response.
   */
  getWritableClient(domain: string): PresenceClient | null;
}

export type PresenceWriteOutcome =
  /** The write was accepted; `updated` is how many rows it actually wrote. */
  | { status: 'written'; updated: number; lastSeenAt: string }
  /** No project is registered that could accept the write. */
  | { status: 'no-client' }
  /** A project accepted the request and the write itself failed. */
  | { status: 'failed'; message: string };

export const defaultPresenceWriteDeps: PresenceWriteDeps = {
  getWritableClient(domain) {
    return projectManager.getWritableProject(domain)?.client ?? null;
  },
};

/**
 * Mark `userId` as currently connected by stamping `profiles.last_seen_at`.
 *
 * `userId` MUST be the gateway-verified caller id. This function does not and
 * cannot check that, which is why the route reads it off the authenticated
 * request and never off the body - a body-supplied id would let any signed-in
 * user mark any other account as online.
 *
 * `updated: 0` is a first-class outcome, not folded into success. It means the
 * token was valid and no profile row was written, so the heartbeat is going
 * nowhere while reporting nothing wrong. Collapsing it into `written` would
 * restore the exact invisibility this module was written to remove.
 */
export async function writePresenceHeartbeat(
  userId: string,
  deps: PresenceWriteDeps = defaultPresenceWriteDeps,
  now: () => Date = () => new Date(),
): Promise<PresenceWriteOutcome> {
  return writePresenceTimestamp(userId, now().toISOString(), deps);
}

/**
 * Remove the caller's presence because they explicitly signed out.
 *
 * This is the "untrack" step, and Tone has no other way to express it: there is
 * no Realtime presence channel in this project - `GatewayChannel` in
 * `src/lib/gateway.ts` is a local shim whose `subscribe()` connects to nothing
 * and which implements neither `track()`, `untrack()`, `presenceState()` nor
 * `presence_diff`, and whose `send({type:'broadcast'})` dispatches only to
 * broadcast listeners in the SAME tab. A local broadcast cannot reach another
 * user, so the marker has to be persisted, and persisting it is what the other
 * user's existing presence refresh reads.
 *
 * Consequences of that, which the caller is responsible for honouring:
 *
 *   - The write is keyed on `userId` and MUST be the gateway-verified caller id,
 *     exactly as for the heartbeat. Otherwise this endpoint would let any
 *     signed-in user force any other account offline.
 *   - It must run BEFORE the session is destroyed, while the bearer token still
 *     authenticates it. See `endPresenceSession` in the frontend.
 *   - It must be the LAST presence write for this session. A heartbeat that
 *     lands after it overwrites the marker with `now` and the dot goes green
 *     again for a full freshness window, which is why the caller pauses the
 *     heartbeat first.
 *
 * The cost is that a user who logs out shows "a while ago" rather than the
 * precise minute they left. That is the deliberate trade: the alternative is a
 * green dot on someone who has signed out, which is the bug being fixed. The
 * next heartbeat after they sign back in restores precision immediately.
 */
export async function writePresenceLogout(
  userId: string,
  deps: PresenceWriteDeps = defaultPresenceWriteDeps,
): Promise<PresenceWriteOutcome> {
  return writePresenceTimestamp(userId, PRESENCE_LOGGED_OUT_AT, deps);
}

/**
 * The single place a presence value is persisted.
 *
 * Both writers differ only in the value, and sharing the query means the
 * identity guarantee, the single-row match and the three-state outcome cannot
 * drift apart between "mark me online" and "mark me offline".
 */
async function writePresenceTimestamp(
  userId: string,
  value: string,
  deps: PresenceWriteDeps,
): Promise<PresenceWriteOutcome> {
  if (typeof userId !== 'string' || userId.length === 0) {
    // A write with no verified subject cannot be persisted, and guessing one
    // would be the presence-spoofing primitive the route is written to avoid.
    // For logout this is the same hole seen from the other side: it would mark an
    // arbitrary account offline.
    return { status: 'failed', message: 'missing caller id' };
  }

  const client = resolvePresenceClient(deps);
  if (!client) return { status: 'no-client' };

  try {
    // `.eq('id', ...)` is a primary-key match, so this touches exactly one row.
    // `.select('id')` makes the UPDATE return the rows it wrote rather than
    // assuming it wrote one.
    const { data, error } = await client
      .from('profiles')
      .update({ last_seen_at: value })
      .eq('id', userId)
      .select('id');
    if (error) {
      const message = typeof error?.message === 'string' ? error.message : 'unknown error';
      return { status: 'failed', message };
    }
    return { status: 'written', updated: data?.length ?? 0, lastSeenAt: value };
  } catch (err) {
    return { status: 'failed', message: (err as Error)?.message ?? 'threw' };
  }
}

function resolvePresenceClient(deps: PresenceWriteDeps): PresenceClient | null {
  for (const domain of PRESENCE_PROFILE_DOMAINS) {
    const candidate = deps.getWritableClient(domain);
    if (candidate) return candidate;
  }
  return null;
}
