// Gateway-owned "Channel pin policy" (messages.md).
//
// Pinning/unpinning is a moderator permission. The generic `pinned_messages`
// POST (insert) and DELETE (by id or by filter) routes ran with service-key
// clients that ignore RLS, so any authenticated caller could pin/unpin in any
// conversation. This module closes the bypass for channels: when a pinned row
// belongs to a `channel` conversation, only the owner/moderator may create or
// delete it. Pins in DMs/groups keep their existing behaviour.
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';
import { resolveChannelContext, isChannel, isOwnerOf, isModeratorOf } from './channelContext';

export type ChannelPinGateResult =
  | { status: 'ok'; channel: boolean }
  | { status: 'conversation_not_found' }
  | { status: 'not_authorized' };

// Gate an operation on a known conversation (the POST body carries it).
export async function evaluatePinPolicy(
  conversationId: string | null,
  callerUserId: string | undefined,
  projects?: Array<{ client: SupabaseClient }> | null
): Promise<ChannelPinGateResult> {
  if (!conversationId || !callerUserId) return { status: 'conversation_not_found' };
  const ctx = await resolveChannelContext(conversationId, callerUserId, projects ?? null);
  if (!ctx) return { status: 'conversation_not_found' };
  if (!isChannel(ctx)) return { status: 'ok', channel: false };
  const admin = isOwnerOf(ctx, callerUserId) || isModeratorOf(ctx, callerUserId);
  if (!admin) return { status: 'not_authorized' };
  return { status: 'ok', channel: true };
}

type PinnedRow = { id?: string; conversation_id?: string | null; message_id?: string | null };

// Resolve the conversation(s) a pinned row (or set of rows) belongs to across
// the readable 'pinned_messages' hosts (sharded deployments).
async function resolvePinnedConversationIds(
  id?: string,
  messageId?: string,
  conversationId?: string,
  projects?: Array<{ client: SupabaseClient }> | null
): Promise<string[]> {
  const hosts = projects ?? projectManager.getReadableProjects('pinned_messages');
  const ids = new Set<string>();
  if (conversationId) ids.add(conversationId);
  for (const entry of hosts) {
    try {
      let query = entry.client.from('pinned_messages').select('conversation_id');
      if (id) query = query.eq('id', id);
      else if (messageId) query = query.eq('message_id', messageId);
      const { data } = await query;
      for (const row of (data as PinnedRow[] | null) || []) {
        if (row.conversation_id) ids.add(row.conversation_id);
      }
      if (data !== null && (data as unknown[]).length > 0) break;
    } catch {
      // Try the next readable host.
    }
  }
  return Array.from(ids);
}

// Gate a delete that is not driven by an explicit conversation id (DELETE by
// pinned row id, or bulk DELETE by filter). Every matched conversation that is
// a channel requires the caller to be its owner/moderator; DMs/groups pass.
export async function evaluatePinDeletePolicy(
  callerUserId: string | undefined,
  opts: { id?: string; messageId?: string; conversationId?: string },
  projects?: Array<{ client: SupabaseClient }> | null
): Promise<ChannelPinGateResult> {
  const conversationIds = await resolvePinnedConversationIds(
    opts.id,
    opts.messageId,
    opts.conversationId,
    projects ?? null
  );
  if (conversationIds.length === 0) {
    // Nothing matched — nothing to delete.
    return { status: 'ok', channel: false };
  }
  for (const conversationId of conversationIds) {
    const result = await evaluatePinPolicy(conversationId, callerUserId, projects ?? null);
    if (result.status !== 'ok') return result;
  }
  return { status: 'ok', channel: true };
}