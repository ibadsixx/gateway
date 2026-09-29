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

import { projectManager } from '../project-manager';

export const PRESENCE_PROFILE_DOMAINS = ['profiles', 'users'] as const;

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
  if (typeof userId !== 'string' || userId.length === 0) {
    // A heartbeat with no verified subject cannot be written, and guessing one
    // would be the presence-spoofing primitive the route is written to avoid.
    return { status: 'failed', message: 'missing caller id' };
  }

  let client: PresenceClient | null = null;
  for (const domain of PRESENCE_PROFILE_DOMAINS) {
    const candidate = deps.getWritableClient(domain);
    if (candidate) {
      client = candidate;
      break;
    }
  }
  if (!client) return { status: 'no-client' };

  const lastSeenAt = now().toISOString();
  try {
    // `.eq('id', ...)` is a primary-key match, so this touches exactly one row.
    // `.select('id')` makes the UPDATE return the rows it wrote rather than
    // assuming it wrote one.
    const { data, error } = await client
      .from('profiles')
      .update({ last_seen_at: lastSeenAt })
      .eq('id', userId)
      .select('id');
    if (error) {
      const message = typeof error?.message === 'string' ? error.message : 'unknown error';
      return { status: 'failed', message };
    }
    return { status: 'written', updated: data?.length ?? 0, lastSeenAt };
  } catch (err) {
    return { status: 'failed', message: (err as Error)?.message ?? 'threw' };
  }
}
