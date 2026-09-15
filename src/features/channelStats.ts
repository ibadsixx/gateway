// Gateway-owned channel statistics (messages.md).
//
// The proxied conversations-host DB `get_channel_stats` counts every
// conversation_participants row by `role` and resolves owner_name via a
// `profiles` join — but the conversations host does not host `profiles`, and a
// legacy `follow_channel` upsert can leave the OWNER with a stale `follower`
// role, which inflates the follower count and hides the owner name. Following
// the get_channel_members / get_channel_user_role precedent, the stats are
// computed here GATEWAY-SIDE from the same `conversation_participants` rows the
// Members list uses:
//   - the authoritative owner (conversations.created_by, participant row with
//     role='owner' as fallback) is ALWAYS excluded from the follower count, so a
//     stale owner `follower` row cannot inflate it;
//   - moderator_count counts the stored role='moderator' rows (an owner stored
//     explicitly as a moderator is counted);
//   - owner_name/owner_id resolve from the owner, enriched from the users host
//     (`projects` is used by the offline test harness to inject in-memory
//     Supabase clients).
// Authorization (owner/moderators only) is decided by the caller.
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';
import type { ChannelContext } from './channelContext';

export async function computeChannelStats(
  ctx: ChannelContext,
  projects?: Array<{ client: SupabaseClient }> | null
): Promise<Array<Record<string, unknown>>> {
  const { data: participants } = await ctx.client
    .from('conversation_participants')
    .select('user_id, role')
    .eq('conversation_id', ctx.conversationId);
  const rows = (participants as Array<Record<string, unknown>>) || [];
  const isOwnerRow = (r: Record<string, unknown>): boolean =>
    r['user_id'] === ctx.createdBy || r['user_id'] === ctx.ownerId || r['role'] === 'owner';
  const ownerId = ctx.createdBy ?? ctx.ownerId ?? null;
  const followerCount = rows.filter((r) => r['role'] === 'follower' && !isOwnerRow(r)).length;
  const moderatorCount = rows.filter((r) => r['role'] === 'moderator').length;

  let ownerName = 'Unknown';
  const profileClient = (projects ?? projectManager.getReadableProjects('profiles'))[0]?.client;
  if (profileClient && ownerId) {
    try {
      const { data } = await profileClient
        .from('profiles')
        .select('username, display_name')
        .eq('id', ownerId)
        .maybeSingle();
      const profile = data as { username?: string | null; display_name?: string | null } | null;
      ownerName = profile?.display_name || profile?.username || 'Unknown';
    } catch {
      // Leave owner_name as 'Unknown' if the users host is unavailable.
    }
  }

  return [{
    follower_count: followerCount,
    owner_id: ownerId,
    owner_name: ownerName,
    moderator_count: moderatorCount,
  }];
}