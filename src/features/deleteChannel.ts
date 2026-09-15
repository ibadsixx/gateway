// Gateway-owned "Delete channel" operation (messages.md).
//
// ONLY the channel owner (conversations.created_by, or the participant row with
// role='owner' as fallback) may delete a channel. The gateway verifies the
// caller server-side before deleting the `conversations` row; the foreign-key
// cascade then removes the channel's messages, pins, participants, settings and
// reports. A moderator or follower that calls the gateway directly is denied.
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveChannelContext, isChannel, isOwnerOf } from './channelContext';

export type DeleteChannelResult =
  | { status: 'ok' }
  | { status: 'not_authenticated' }
  | { status: 'conversation_not_found' }
  | { status: 'not_channel' }
  | { status: 'not_owner' };

export async function deleteChannel(
  conversationId: string | null,
  callerUserId: string | undefined,
  projects?: Array<{ client: SupabaseClient }> | null
): Promise<DeleteChannelResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  const ctx = await resolveChannelContext(conversationId, callerUserId, projects ?? null);
  if (!ctx) return { status: 'conversation_not_found' };
  if (!isChannel(ctx)) return { status: 'not_channel' };
  if (!isOwnerOf(ctx, callerUserId)) return { status: 'not_owner' };

  const { error } = await ctx.client
    .from('conversations')
    .delete()
    .eq('id', ctx.conversationId);
  if (error) throw new Error(`Failed to delete channel: ${error.message}`);

  return { status: 'ok' };
}