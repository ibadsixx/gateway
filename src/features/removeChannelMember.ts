// Gateway-owned "Remove channel member" operation (messages.md).
//
// The channel owner may remove followers and moderators from the channel.
// Removing a member deletes ONLY their `conversation_participants` row — the
// conversation, its messages, other members, and the user's account are never
// touched. The channel owner is protected and cannot be removed through this
// operation. Self-removal is refused — use unfollow_channel (Leave) instead.
//
// Authorization: ONLY the channel owner (conversations.created_by, or the
// participant row with role='owner' as fallback) may remove members. All
// checks run server-side in the gateway using service-role clients on the
// conversations host. The SPA never holds the authority.
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';

export type RemoveChannelMemberResult =
  | { status: 'ok' }
  | { status: 'not_member' }
  | { status: 'not_channel' }
  | { status: 'not_owner' }
  | { status: 'owner_protected' }
  | { status: 'self_removal' }
  | { status: 'member_not_found' };

export async function removeChannelMember(
  conversationId: string,
  targetUserId: string,
  callerUserId: string
): Promise<RemoveChannelMemberResult> {
  if (!conversationId || !targetUserId || !callerUserId) return { status: 'not_member' };

  const participants = projectManager.getReadableProjects('conversation_participants');
  if (participants.length === 0) return { status: 'not_member' };

  // 1. Locate the conversation and the owner. Sharded hosts are tried in order;
  //    the first host that owns the conversations row also owns the participant
  //    rows (same DB). conversations.created_by is the authoritative owner.
  let convType: string | null = null;
  let createdBy: string | null = null;
  let ownerId: string | null = null;
  let hostClient: SupabaseClient | null = null;

  for (const entry of participants) {
    try {
      const [{ data: conv }, { data: ownerRow }] = await Promise.all([
        entry.client
          .from('conversations')
          .select('type, created_by')
          .eq('id', conversationId)
          .maybeSingle(),
        entry.client
          .from('conversation_participants')
          .select('user_id')
          .eq('conversation_id', conversationId)
          .eq('role', 'owner')
          .maybeSingle(),
      ]);
      if (conv) {
        convType = (conv as { type?: string | null }).type ?? null;
        createdBy = (conv as { created_by?: string | null }).created_by ?? null;
        if (!hostClient) hostClient = entry.client;
      }
      if (ownerRow) {
        ownerId = (ownerRow as { user_id?: string }).user_id ?? null;
      }
      if (convType !== null || hostClient !== null) break;
    } catch {
      // Try the next readable host.
    }
  }

  if (!hostClient || !convType) return { status: 'not_member' };

  // 2. Only channels have removable members — DMs and groups are refused.
  if (convType !== 'channel') return { status: 'not_channel' };

  // 3. Only the channel owner may remove members.
  const isOwner =
    createdBy === callerUserId ||
    (createdBy === null && ownerId === callerUserId);

  if (!isOwner) {
    // Verify the caller is at least a participant before 403 vs 404.
    try {
      const { data: caller } = await hostClient
        .from('conversation_participants')
        .select('user_id')
        .eq('conversation_id', conversationId)
        .eq('user_id', callerUserId)
        .maybeSingle();
      if (!caller) return { status: 'not_member' };
    } catch {
      // Host read failed — fall through to not_owner.
    }
    return { status: 'not_owner' };
  }

  // 4. The owner is protected and must not be removable.
  if (targetUserId === createdBy || (createdBy === null && targetUserId === ownerId)) {
    return { status: 'owner_protected' };
  }

  // 5. Self-removal is refused — the caller must use unfollow_channel (Leave).
  if (targetUserId === callerUserId) {
    return { status: 'self_removal' };
  }

  // 6. Verify the target is actually a participant.
  const { data: target } = await hostClient
    .from('conversation_participants')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('user_id', targetUserId)
    .maybeSingle();

  if (!target) return { status: 'member_not_found' };

  // 7. Delete ONLY the target's participant row — nothing else.
  const { error } = await hostClient
    .from('conversation_participants')
    .delete()
    .eq('id', target.id);

  if (error) throw new Error(`Failed to remove channel member: ${error.message}`);

  return { status: 'ok' };
}
