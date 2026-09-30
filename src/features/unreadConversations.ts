// Global Messages-badge unread source, Gateway side (do.md "Fix the Messages
// unread notification badge" / mobile-badge round).
//
// The badge on the Messages icon in global navigation is defined as:
//
//   the number of conversations that currently contain unread messages
//
// (NOT the total number of unread messages, and NOT the read state inside the
// Messages page). The read-state architecture is `message_reads` (a row per
// message per reader): a message sent by someone else that the current user has
// no `message_reads` row for is unread.
//
// WHY THIS USES THE EXISTING `get_conversations_with_info`
//
// The obvious implementation is a purpose-built `SELECT DISTINCT conversation_id`
// table function — lean, minimal payload, one row per unread conversation. It
// was written for exactly this and lives in
// supabase/migrations/20260929000000_get_unread_conversation_ids.sql. It is not
// used, because it requires a migration to be applied before the badge works at
// all, and until that happens the count is silently 0 on every layout.
//
// `get_conversations_with_info` already exists in the deployed database and
// already computes `unread_count` per conversation with precisely the predicate
// this badge needs — `sender_id <> p_user_id`, no `message_reads` row, and
// nothing at or before the user's `conversation_clears.cleared_at` (see
// supabase/migrations/20260603000006_add_group_conversations.sql). It also
// already returns `type` and `other_user_id`. So the badge is a filter over a
// function that is already the product's own definition of "unread":
//
//     unread conversation == unread_count > 0
//
// The trade is honest and stated: this transfers one row per conversation the
// viewer participates in, with the profile join and last-message columns the
// inbox already needs, instead of one bare uuid per unread conversation. It is
// one RPC call either way, and it removes a deployment dependency. The lean
// function is still worth revisiting if the conversation count grows large.
//
// Block filtering stays here rather than in SQL, because `blocks` lives on a
// different project host than the conversations tables. The rule mirrors the
// app's own `filterRequestConversations`: a DM whose single other participant is
// in the viewer's block set is dropped; groups and channels keep their
// participant-based visibility, so a blocked member does not hide them.
//
// The route (api/routes.ts) intercepts `rpc('get_unread_conversation_ids')` and
// calls this module with the gateway-verified caller id, never a client-supplied
// value. That matters more than usual here: the underlying function takes a
// `p_user_id` argument, so a body-supplied id would let any signed-in user read
// any other user's unread state.

import { projectManager } from '../project-manager';

/** The pre-existing database function that already carries the unread count. */
const CONVERSATIONS_RPC = 'get_conversations_with_info';

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
    // readable first, then the users host, then writable — mirroring
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
        // whole badge read; the conversation read is authoritative on its own.
      }
    }
    return ids;
  },
};

/**
 * A row of `get_conversations_with_info`, as far as the badge cares.
 * `unread_count` is a SQL `COUNT(*)`, which PostgREST may hand back as a
 * number or as a string depending on the bigint path, so it is coerced rather
 * than compared directly.
 */
interface ConversationRow {
  conversation_id?: unknown;
  type?: unknown;
  other_user_id?: unknown;
  unread_count?: unknown;
}

function hasUnread(row: ConversationRow): boolean {
  const n = typeof row.unread_count === 'string' ? Number(row.unread_count) : row.unread_count;
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

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
    const res = await client.rpc(CONVERSATIONS_RPC, { p_user_id: userId });
    if (res.error) return { status: 'failed', message: res.error.message };
    data = res.data;
  } catch (err) {
    return {
      status: 'failed',
      message: (err as Error)?.message ?? 'conversations read threw',
    };
  }

  const rows: ConversationRow[] = Array.isArray(data) ? (data as ConversationRow[]) : [];
  const unread = rows.filter((row) => typeof row.conversation_id === 'string' && hasUnread(row));
  const ids = unread.map((row) => row.conversation_id as string);

  if (ids.length === 0) return { status: 'ok', conversationIds: [] };

  // Blocked peers must not light the badge. A DM has exactly one other
  // participant, which the function already returns as `other_user_id`, so this
  // needs no further query. Fail open: a block-host outage must not blank a
  // badge the user can already see, and the conversation read is authoritative.
  let blocked: Set<string>;
  try {
    blocked = await deps.getBlockedPeerIds(userId);
  } catch {
    blocked = new Set<string>();
  }
  if (blocked.size === 0) return { status: 'ok', conversationIds: ids };

  return {
    status: 'ok',
    conversationIds: unread
      .filter((row) => {
        if (row.type !== 'dm') return true;
        const otherId = row.other_user_id;
        return !(typeof otherId === 'string' && blocked.has(otherId));
      })
      .map((row) => row.conversation_id as string),
  };
}
