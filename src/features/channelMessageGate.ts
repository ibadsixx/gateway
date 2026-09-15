// Gateway-owned channel message policy (messages.md).
//
// Channel posts are broadcast content: followers are read-only and can never
// create posts in the first place. Editing and deleting channel posts are
// moderator permissions, so the generic PUT/DELETE /api/v1/messages/:id routes
// must not let a follower mutate a channel post by calling the gateway directly.
// This module resolves the message's conversation across the sharded hosts and
// enforces the channel rules; non-channel conversations fall through unchanged
// to the existing generic behaviour.
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';
import { resolveChannelContext, isChannel, isOwnerOf, isModeratorOf } from './channelContext';

export type ChannelMessageGateResult =
  | { status: 'ok'; channel: boolean; conversationId: string; senderId: string | null }
  | { status: 'message_not_found' }
  | { status: 'not_authorized' };

type MessageRow = { id: string; conversation_id?: string | null; sender_id?: string | null };

// Locate the message across the readable 'messages' hosts (sharded
// deployments). Returns null when the row is not found anywhere.
async function resolveMessageRow(
  messageId: string | null,
  projects?: Array<{ client: SupabaseClient }> | null
): Promise<MessageRow | null> {
  if (!messageId) return null;
  const hosts = projects ?? projectManager.getReadableProjects('messages');
  for (const entry of hosts) {
    try {
      const { data } = await entry.client
        .from('messages')
        .select('id, conversation_id, sender_id')
        .eq('id', messageId)
        .maybeSingle();
      if (data) return data as MessageRow;
    } catch {
      // Try the next readable host.
    }
  }
  return null;
}

/**
 * Resolve the message's conversation and enforce the channel policy for the
 * caller:
 *  - message missing            -> message_not_found
 *  - channel + not admin        -> not_authorized
 *  - channel + admin (or sender, for delete) -> ok
 *  - non-channel                -> ok (generic behaviour continues)
 */
export async function evaluateChannelMessageGate(
  messageId: string | null,
  callerUserId: string | undefined,
  projects?: Array<{ client: SupabaseClient }> | null
): Promise<ChannelMessageGateResult> {
  const message = await resolveMessageRow(messageId, projects ?? null);
  if (!message || !message.conversation_id) return { status: 'message_not_found' };

  const ctx = await resolveChannelContext(message.conversation_id, callerUserId, projects ?? null);
  if (!ctx) return { status: 'message_not_found' };

  if (!isChannel(ctx)) {
    return {
      status: 'ok',
      channel: false,
      conversationId: message.conversation_id,
      senderId: message.sender_id ?? null,
    };
  }

  const isSender = !!callerUserId && message.sender_id === callerUserId;
  const allowed = isOwnerOf(ctx, callerUserId) || isModeratorOf(ctx, callerUserId) || isSender;
  if (!allowed) return { status: 'not_authorized' };

  return {
    status: 'ok',
    channel: true,
    conversationId: message.conversation_id,
    senderId: message.sender_id ?? null,
  };
}

// Columns a channel moderator/owner may modify when editing a post. The row
// identity columns (id, conversation_id, sender_id) are never client-driven.
export const CHANNEL_EDITABLE_COLUMNS = new Set([
  'content',
  'image_url',
  'media_url',
  'attachment_url',
  'is_image',
  'is_video',
  'message_type',
]);

export function stripNonEditable(body: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (CHANNEL_EDITABLE_COLUMNS.has(key)) clean[key] = body[key];
  }
  return clean;
}