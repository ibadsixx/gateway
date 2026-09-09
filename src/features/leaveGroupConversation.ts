// Gateway-owned "Leave group" operation (messages.md).
//
// The SPA never talks to Supabase directly — every group-chat membership change
// flows through the Gateway. This module is the single choke point for leaving a
// group conversation:
//   - ONLY the authenticated caller's OWN `conversation_participants` row is
//     deleted — never another member, never the conversation, its messages, or
//     the group itself;
//   - the caller MUST already be a member: membership is verified server-side
//     before any write, so a non-member can never trigger a leave;
//   - only `group` conversations can be left — DMs and channels are refused
//     without touching anything;
//   - conversation_participants and conversations live in the same physical
//     host, so the DB row that pins the caller's membership also pins the host
//     used to verify the conversation type and run the delete.
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';

export type LeaveGroupResult =
  | { status: 'ok' }
  | { status: 'not_member' }
  | { status: 'not_group' };

export function isGroupType(type: string | null | undefined): boolean {
  return type === 'group';
}

export async function leaveGroupConversation(
  conversationId: string,
  userId: string
): Promise<LeaveGroupResult> {
  if (!conversationId || !userId) return { status: 'not_member' };

  const participants = projectManager.getReadableProjects('conversation_participants');
  if (participants.length === 0) return { status: 'not_member' };

  // 1. Find the caller's membership row. Sharded hosts are tried in order; the
  //    first host that owns the row also owns the `conversations` row (same DB).
  let membershipId: string | null = null;
  let hostClient: SupabaseClient | null = null;
  for (const entry of participants) {
    try {
      const { data } = await entry.client
        .from('conversation_participants')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('user_id', userId)
        .maybeSingle();
      if (data) {
        membershipId = data.id;
        hostClient = entry.client;
        break;
      }
    } catch {
      // Try the next readable host.
    }
  }
  if (!membershipId || !hostClient) return { status: 'not_member' };

  // 2. Only groups may be left; refuse DMs/channels without modifying anything.
  try {
    const { data: conv } = await hostClient
      .from('conversations')
      .select('type')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conv || !isGroupType(conv.type)) return { status: 'not_group' };
  } catch {
    return { status: 'not_group' };
  }

  // 3. Remove ONLY the caller's own membership row.
  const { error } = await hostClient
    .from('conversation_participants')
    .delete()
    .eq('id', membershipId);
  if (error) throw new Error(`Failed to remove group membership: ${error.message}`);

  return { status: 'ok' };
}