// Gateway-owned "Remove channel member" operation (messages.md).
//
// The channel owner may remove followers and moderators; a moderator may remove
// FOLLOWERS only (moderator-level or owner-level members stay owner-only). The
// owner is protected and cannot be removed through this operation. Self-removal
// is refused — the caller must use unfollow_channel (Leave) instead; removing a
// member deletes ONLY their `conversation_participants` row — the conversation,
// its messages, other members, and the user's account are never touched.
//
// Authorization: computed GATEWAY-SIDE against conversation_participants on the
// conversations host (resolver in channelContext.ts), using the gateway-verified
// caller id. The SPA never holds the authority.
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveChannelContext,
  isChannel,
  isOwnerOf,
} from './channelContext';

export type RemoveChannelMemberResult =
  | { status: 'ok' }
  | { status: 'not_member' }
  | { status: 'not_channel' }
  | { status: 'not_owner' }
  | { status: 'target_is_moderator' }
  | { status: 'owner_protected' }
  | { status: 'self_removal' }
  | { status: 'member_not_found' };

export async function removeChannelMember(
  conversationId: string,
  targetUserId: string,
  callerUserId: string,
  projects?: Array<{ client: SupabaseClient }> | null
): Promise<RemoveChannelMemberResult> {
  if (!conversationId || !targetUserId || !callerUserId) return { status: 'not_member' };

  const ctx = await resolveChannelContext(conversationId, callerUserId, projects ?? null);
  if (!ctx) return { status: 'not_member' };
  if (!isChannel(ctx)) return { status: 'not_channel' };

  const isOwner = isOwnerOf(ctx, callerUserId);
  // A non-owner who is not even a participant reads as a 404, not a 403.
  if (!isOwner && !ctx.callerRole) return { status: 'not_member' };
  const isModerator = ctx.callerRole === 'moderator';

  // Self-removal is refused for EVERY role — the caller must use
  // unfollow_channel (Leave) instead.
  if (targetUserId === callerUserId) return { status: 'self_removal' };

  if (!isOwner && !isModerator) return { status: 'not_owner' };

  // The owner is protected and must not be removable.
  if (isOwnerOf(ctx, targetUserId)) return { status: 'owner_protected' };

  // Verify the target is actually a participant and pin their role.
  const { data: target } = await ctx.client
    .from('conversation_participants')
    .select('id, role')
    .eq('conversation_id', conversationId)
    .eq('user_id', targetUserId)
    .maybeSingle();
  if (!target) return { status: 'member_not_found' };

  // Moderator callers can only remove FOLLOWERS; removing a moderator (or the
  // owner) is an owner-only action.
  if (!isOwner && (target as { role?: string }).role !== 'follower') {
    return { status: 'target_is_moderator' };
  }

  // Delete ONLY the target's participant row — nothing else.
  const { error } = await ctx.client
    .from('conversation_participants')
    .delete()
    .eq('id', (target as { id: string }).id);
  if (error) throw new Error(`Failed to remove channel member: ${error.message}`);

  return { status: 'ok' };
}