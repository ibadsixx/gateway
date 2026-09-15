// Gateway-owned "channel moderator" operations (messages.md).
//
// The deployed add_channel_moderator / remove_channel_moderator SECURITY DEFINER
// functions live on the conversations host and resolve the acting user with
// auth.uid(). The conversations project does not share the users JWT secret, so
// a cross-project anon call (the only bearer the gateway can use there) yields
// auth.uid() = NULL and the function raises 'Not authenticated' for EVERY caller
// — including the channel owner. The repo signatures also name the target
// parameter `p_user_id`, while the SPA has always sent `p_moderator_id`, so the
// target arrived NULL even when the function could run.
//
// Following the get_channel_user_role / get_channel_members precedent, promotion
// and demotion are therefore computed GATEWAY-SIDE against
// conversation_participants on the conversations host, using the gateway-verified
// caller id. The gateway is the single choke point:
//   - ONLY the channel owner (conversations.created_by, or the participant row
//     with role='owner' as fallback) may promote/demote — enforced here, so a
//     follower or moderator is denied even if they call the gateway directly;
//   - the TARGET must already be a participant of the channel (no ad-hoc second
//     membership row, no second user record);
//   - the channel owner is protected and can never be rewritten to moderator or
//     demoted (the old DB functions could corrupt the owner row);
//   - promotion is idempotent: re-promoting an existing moderator is a no-op;
//   - demotion returns the owner to 'follower' (channel member, message/post
//     history, friendship and account all untouched).
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';

export type ChannelModeratorResult =
  | { status: 'ok' }
  | { status: 'conversation_not_found' }
  | { status: 'not_channel' }
  | { status: 'not_authenticated' }
  | { status: 'not_owner' }
  | { status: 'owner_protected' }
  | { status: 'target_required' }
  | { status: 'target_not_member' }
  | { status: 'target_not_moderator' };

type HostContext = {
  client: SupabaseClient;
  conversationId: string;
  type: string;
  createdBy: string | null;
  ownerId: string | null;
};

async function resolveConversationHost(
  conversationId: string | null,
  projects: Array<{ client: SupabaseClient }> | null
): Promise<HostContext | null> {
  if (!conversationId) return null;
  const hosts = projects ?? projectManager.getReadableProjects('conversations');
  for (const entry of hosts) {
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
      const found = conv as { type?: string | null; created_by?: string | null } | null;
      if (found) {
        return {
          client: entry.client,
          conversationId,
          type: found.type ?? 'channel',
          createdBy: found.created_by ?? null,
          ownerId: (ownerRow as { user_id?: string } | null | undefined)?.user_id ?? null,
        };
      }
    } catch {
      // Try the next readable host (sharded deployments).
    }
  }
  return null;
}

function isOwnerOf(ctx: HostContext, userId: string): boolean {
  return ctx.createdBy === userId || (ctx.createdBy === null && ctx.ownerId === userId);
}

// Promote a channel member to moderator (owner only). Idempotent.
export async function addChannelModerator(
  conversationId: string | null,
  targetUserId: string | null,
  callerUserId: string | undefined,
  projects?: Array<{ client: SupabaseClient }> | null
): Promise<ChannelModeratorResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (!targetUserId) return { status: 'target_required' };
  const ctx = await resolveConversationHost(conversationId, projects ?? null);
  if (!ctx) return { status: 'conversation_not_found' };
  if (ctx.type !== 'channel') return { status: 'not_channel' };
  if (!isOwnerOf(ctx, callerUserId)) return { status: 'not_owner' };
  if (isOwnerOf(ctx, targetUserId)) return { status: 'owner_protected' };

  // Target must already be a participant — never mint a second membership row.
  const { data: target } = await ctx.client
    .from('conversation_participants')
    .select('role')
    .eq('conversation_id', ctx.conversationId)
    .eq('user_id', targetUserId)
    .maybeSingle();
  if (!target) return { status: 'target_not_member' };

  // Unique (conversation_id, user_id) makes this a safe, idempotent upsert:
  // re-promoting an existing moderator lands on the same 'moderator' value.
  const { error } = await ctx.client
    .from('conversation_participants')
    .update({ role: 'moderator' })
    .eq('conversation_id', ctx.conversationId)
    .eq('user_id', targetUserId);
  if (error) throw new Error(`Failed to add channel moderator: ${error.message}`);

  return { status: 'ok' };
}

// Remove the moderator role from a channel member (owner only). The member stays
// as a regular 'follower' of the channel.
export async function removeChannelModerator(
  conversationId: string | null,
  targetUserId: string | null,
  callerUserId: string | undefined,
  projects?: Array<{ client: SupabaseClient }> | null
): Promise<ChannelModeratorResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (!targetUserId) return { status: 'target_required' };
  const ctx = await resolveConversationHost(conversationId, projects ?? null);
  if (!ctx) return { status: 'conversation_not_found' };
  if (ctx.type !== 'channel') return { status: 'not_channel' };
  if (!isOwnerOf(ctx, callerUserId)) return { status: 'not_owner' };
  if (isOwnerOf(ctx, targetUserId)) return { status: 'owner_protected' };

  const { data: target } = await ctx.client
    .from('conversation_participants')
    .select('role')
    .eq('conversation_id', ctx.conversationId)
    .eq('user_id', targetUserId)
    .maybeSingle();
  if (!target) return { status: 'target_not_member' };

  const role = (target as { role?: string | null }).role ?? null;
  if (role !== 'moderator') return { status: 'target_not_moderator' };

  const { error } = await ctx.client
    .from('conversation_participants')
    .update({ role: 'follower' })
    .eq('conversation_id', ctx.conversationId)
    .eq('user_id', targetUserId);
  if (error) throw new Error(`Failed to remove channel moderator: ${error.message}`);

  return { status: 'ok' };
}