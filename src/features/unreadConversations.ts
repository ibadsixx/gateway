// Global Messages-badge unread source, Gateway side (do.md "Fix the Messages
// unread notification badge").
//
// The badge on the Messages icon in global navigation is defined as:
//
//   the number of conversations that currently contain unread messages
//
// (NOT the total number of unread messages, and NOT the read state inside the
// Messages page). The read-state architecture is `message_reads` (a row per
// message per reader): a message sent by someone else that the current user has
// no `message_reads` row for is unread. This is exactly the predicate the
// existing per-chat unread badges already derive from, just aggregated across
// every conversation the viewer participates in instead of one list.
//
// WHY GATEWAY-SIDE AND NOT A CLIENT QUERY:
//
//   - The requirement is an efficient aggregate, not "fetch every message from
//     every conversation". PostgREST cannot express "the set of conversation
//     ids with at least one unread message" in one request, so the aggregation
//     runs in the database (`get_unread_conversation_ids`) and this module is
//     the only caller that produces it.
//   - `blocks` lives on the blocking host, not the conversations host, so "a
//     blocked peer's messages must never light the badge" cannot be enforced in
//     the same SQL. The conversation set is intersected with the viewer's block
//     list here, where both hosts are reachable — the same split the
//     suggestions feature uses for its cross-project rules.
//
// The route (api/routes.ts) intercepts `rpc('get_unread_conversation_ids')`
// and calls this module with the gateway-verified caller id, never a
// client-supplied value. The caller id is required: a body-supplied id would
// let any signed-in user read any other user's unread state.

import { projectManager } from '../project-manager';

/**
 * Minimal shape of the parts of a Supabase client this feature uses. Loosely
 * typed on purpose, matching the convention used by `presence.PresenceClient`
 * and the registry clients (whose row types resolve to `never` for an untyped
 * table). A cast at every call site would be worse than one narrow interface
 * here.
 */
export interface UnreadConversationsClient {
  from(table: string): any;
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

export interface UnreadConversationsDeps {
  /** A service-role client for the conversations host, or null when unavailable. */
  getConversationsClient(): UnreadConversationsClient | null;
  /** The viewer's blocked ids (both directions), from the blocking host. */
  getBlockedPeerIds(userId: string): Promise<Set<string>>;
}

export type UnreadConversationsResult =
  /** The set of the caller's conversations that currently contain unread messages. */
  | { status: 'ok'; conversationIds: string[] }
  /** No project is registered that could answer the aggregate read. */
  | { status: 'no-client' }
  /** A project accepted the request and the read itself failed. */
  | { status: 'failed'; message: string };

export const defaultUnreadConversationsDeps: UnreadConversationsDeps = {
  getConversationsClient() {
    // What the conversation tables are fronted by changes across environments
    // (dedicated `conversations` project, or the pre-split `users` host). Try
    // readable first, then writable, then the users host — mirroring
    // `resolveChannelMembers`. A single source of truth for "where do the
    // conversation tables live" would be better, but this is the same ladder
    // every other cross-host read here climbs.
    const candidates = [
      ...projectManager.getReadableProjects('conversations'),
      ...projectManager.getReadableProjects('users'),
    ];
    const seen = new Set<string>();
    for (const entry of candidates) {
      const key = entry.project?.projectUrl ?? '';
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      if (entry.client) return entry.client as UnreadConversationsClient;
    }
    const writable = projectManager.getWritableProject('conversations');
    return (writable?.client ?? null) as UnreadConversationsClient | null;
  },
  async getBlockedPeerIds(userId) {
    const domain =
      projectManager.getReadableProjects('blocking').length > 0 ? 'blocking' : 'users';
    const ids = new Set<string>();
    for (const entry of projectManager.getReadableProjects(domain)) {
      try {
        const { data } = await entry.client
          .from('blocks')
          .select('blocker_id, blocked_id')
          .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);
        for (const r of (data as Array<{ blocker_id?: string; blocked_id?: string }>) ?? []) {
          if (r.blocker_id === userId && typeof r.blocked_id === 'string') ids.add(r.blocked_id);
          if (r.blocked_id === userId && typeof r.blocker_id === 'string') ids.add(r.blocker_id);
        }
      } catch {
        // An unreachable block host contributes nothing rather than failing the
        // whole badge read; the SQL aggregate is authoritative on its own host.
      }
    }
    return ids;
  },
};

/**
 * The set of `userId`'s conversations that currently contain unread messages.
 *
 * `userId` MUST be the gateway-verified caller id. This function does not and
 * cannot check that — the route reads it off the authenticated request and
 * never off the body.
 */
export async function getUnreadConversationIds(
  userId: string | undefined,
  deps: UnreadConversationsDeps = defaultUnreadConversationsDeps
): Promise<UnreadConversationsResult> {
  if (!userId) return { status: 'failed', message: 'missing caller id' };

  const client = deps.getConversationsClient();
  if (!client) return { status: 'no-client' };

  let data: unknown;
  try {
    const res = await client.rpc('get_unread_conversation_ids', { p_user_id: userId });
    if (res.error) return { status: 'failed', message: res.error.message };
    data = res.data;
  } catch (err) {
    return {
      status: 'failed',
      message: (err as Error)?.message ?? 'conversations aggregate threw',
    };
  }

  const ids = (Array.isArray(data) ? data : [])
    .map((row) => (row as { conversation_id?: unknown })?.conversation_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  if (ids.length === 0) return { status: 'ok', conversationIds: [] };

  // Blocked peers must not light the badge (do.md §5). A DM whose single other
  // participant is in the viewer's block set is dropped; groups and channels
  // keep the same participant-based visibility the inbox already uses. Fail
  // open on the block-filter reads: a transient block-host outage must not
  // wipe a user's badge, and the SQL set is authoritative on its own host.
  let blocked: Set<string>;
  try {
    blocked = await deps.getBlockedPeerIds(userId);
  } catch {
    blocked = new Set<string>();
  }
  if (blocked.size === 0) return { status: 'ok', conversationIds: ids };

  try {
    const [convsRes, partsRes] = await Promise.all([
      client.from('conversations').select('id, type').in('id', ids),
      client
        .from('conversation_participants')
        .select('conversation_id, user_id')
        .in('conversation_id', ids)
        .neq('user_id', userId),
    ]);

    const typeById = new Map<string, string | undefined>();
    for (const c of (convsRes?.data as Array<{ id?: string; type?: string }>) ?? []) {
      if (typeof c.id === 'string') typeById.set(c.id, c.type);
    }
    // A DM always has exactly one other participant; the first row wins.
    const otherPerConv = new Map<string, string>();
    for (const p of (partsRes?.data as Array<{ conversation_id?: string; user_id?: string }>) ?? []) {
      if (typeof p.conversation_id === 'string' && typeof p.user_id === 'string') {
        if (!otherPerConv.has(p.conversation_id)) otherPerConv.set(p.conversation_id, p.user_id);
      }
    }

    return {
      status: 'ok',
      conversationIds: ids.filter((id) => {
        if (typeById.get(id) !== 'dm') return true;
        const otherId = otherPerConv.get(id);
        return !(otherId && blocked.has(otherId));
      }),
    };
  } catch {
    // Enrichment for the block filter failed — return the SQL set unfiltered
    // rather than an empty badge, and let the next refresh retry.
    return { status: 'ok', conversationIds: ids };
  }
}