// Shared gateway-side channel context resolver (messages.md).
//
// Every channel authorization decision in the gateway funnels through this
// module. It locates the conversation across the sharded deployments, pins the
// authoritative owner (`conversations.created_by`, falling back to the
// participant row with role='owner` when `created_by` is missing), and captures
// the caller's participant role — all server-side with service-role clients, so
// the SPA can never influence the outcome.
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';

export type ChannelContext = {
  client: SupabaseClient;
  conversationId: string;
  type: string | null;
  createdBy: string | null;
  ownerId: string | null;
  callerRole: string | null;
};

/**
 * Resolves the context of a conversation for a caller. Returns null when the
 * conversation does not exist on any readable host. `projects` is used by the
 * offline test harness to inject in-memory Supabase clients.
 */
export async function resolveChannelContext(
  conversationId: string | null,
  userId: string | null | undefined,
  projects?: Array<{ client: SupabaseClient }> | null
): Promise<ChannelContext | null> {
  if (!conversationId) return null;
  const hosts = projects ?? projectManager.getReadableProjects('conversations');
  for (const entry of hosts) {
    try {
      const [{ data: conv }, { data: participant }, { data: ownerRow }] = await Promise.all([
        entry.client
          .from('conversations')
          .select('type, created_by')
          .eq('id', conversationId)
          .maybeSingle(),
        userId
          ? entry.client
              .from('conversation_participants')
              .select('role')
              .eq('conversation_id', conversationId)
              .eq('user_id', userId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
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
          callerRole: (participant as { role?: string } | null | undefined)?.role ?? null,
        };
      }
    } catch {
      // Try the next readable host (sharded deployments).
    }
  }
  return null;
}

export function isChannel(ctx: ChannelContext): boolean {
  return ctx.type === 'channel';
}

export function isOwnerOf(
  ctx: ChannelContext,
  userId: string | null | undefined
): boolean {
  if (!userId) return false;
  return ctx.createdBy === userId || (ctx.createdBy === null && ctx.ownerId === userId);
}

// A moderator is a participant row with the `moderator` role who is not the
// owner. `ctx.callerRole` is the role resolved for the caller that was passed
// to resolveChannelContext.
export function isModeratorOf(
  ctx: ChannelContext,
  userId: string | null | undefined
): boolean {
  if (!userId || isOwnerOf(ctx, userId)) return false;
  return ctx.callerRole === 'moderator';
}

export function isChannelAdmin(
  ctx: ChannelContext,
  userId: string | null | undefined
): boolean {
  return isOwnerOf(ctx, userId) || isModeratorOf(ctx, userId);
}