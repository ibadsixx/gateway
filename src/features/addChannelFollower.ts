// Gateway-owned "Add channel follower" operation (messages.md).
//
// The deployed add_channel_follower SECURITY DEFINER lives on the conversations
// host and resolves the acting user with auth.uid(). The conversations project
// does not share the users JWT secret, so a cross-project anon call yields
// auth.uid() = NULL and the function raises 'Not authenticated' for every
// caller — owner and moderators included. The SPA also sends `p_new_follower_id`
// while the injected caller param was `p_user_id`, which the function does not
// accept. Following the channelModerator precedent, invites are therefore
// computed GATEWAY-SIDE against conversation_participants:
//   - ONLY the channel owner or a moderator may add followers;
//   - the invited person must be an existing profile (the DB-side FK to
//     `profiles`); a non-existent id is refused;
//   - existing participants are never downgraded — adding someone who is
//     already an owner/moderator/follower is a no-op (ON CONFLICT DO NOTHING);
//   - only `channel` conversations can be invited to.
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';
import { resolveChannelContext, isChannel, isOwnerOf } from './channelContext';

export type AddChannelFollowerResult =
  | { status: 'ok' }
  | { status: 'not_authenticated' }
  | { status: 'conversation_not_found' }
  | { status: 'not_channel' }
  | { status: 'not_member' }
  | { status: 'not_authorized' }
  | { status: 'target_required' }
  | { status: 'target_not_found' };

// Best-effort check that the invited id belongs to a real profile (mirrors the
// `conversation_participants.user_id REFERENCES profiles(id)` constraint). When
// the profiles host is unreachable the lookup is skipped and the insert is
// attempted — the DB-side FK (where it exists) is the final guard.
async function targetExistsAsProfile(
  targetUserId: string | null,
  profilesProjects?: Array<{ client: SupabaseClient }> | null
): Promise<boolean> {
  if (!targetUserId) return false;
  const profiles = profilesProjects ?? projectManager.getReadableProjects('profiles');
  if (profiles.length === 0) return true;
  try {
    const { data } = await profiles[0].client
      .from('profiles')
      .select('id')
      .eq('id', targetUserId)
      .maybeSingle();
    return !!data;
  } catch {
    return true;
  }
}

export async function addChannelFollower(
  conversationId: string | null,
  targetUserId: string | null,
  callerUserId: string | undefined,
  projects?: Array<{ client: SupabaseClient }> | null,
  profilesProjects?: Array<{ client: SupabaseClient }> | null
): Promise<AddChannelFollowerResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (!targetUserId) return { status: 'target_required' };
  const ctx = await resolveChannelContext(conversationId, callerUserId, projects ?? null);
  if (!ctx) return { status: 'conversation_not_found' };
  if (!isChannel(ctx)) return { status: 'not_channel' };

  const callerIsAdmin = isOwnerOf(ctx, callerUserId) || ctx.callerRole === 'moderator';
  if (!callerIsAdmin) {
    if (!ctx.callerRole) return { status: 'not_member' };
    return { status: 'not_authorized' };
  }

  // Mirror the DB function's ON CONFLICT DO NOTHING: an existing participant is
  // left untouched (never downgrade the owner/moderator/follower who is in).
  const { data: existing } = await ctx.client
    .from('conversation_participants')
    .select('id')
    .eq('conversation_id', ctx.conversationId)
    .eq('user_id', targetUserId)
    .maybeSingle();
  if (existing) return { status: 'ok' };

  if (!(await targetExistsAsProfile(targetUserId, profilesProjects))) {
    return { status: 'target_not_found' };
  }

  const { error } = await ctx.client
    .from('conversation_participants')
    .insert({
      conversation_id: ctx.conversationId,
      user_id: targetUserId,
      role: 'follower',
    });
  if (error) throw new Error(`Failed to add channel follower: ${error.message}`);

  return { status: 'ok' };
}