// Gateway-owned "Publish channel post" operation (messages.md).
//
// Channels are broadcast, not a Group Chat: followers have no composer, and
// ONLY the channel owner/moderators can publish. The SPA must not be able to
// bypass that with a raw insert, so publishing flows through this module:
//   - the caller MUST be a participant with role `owner` or `moderator`
//     (verified server-side before any write). Everyone else gets
//     `not_publisher` and nothing is touched;
//   - only `channel` conversations can be published to — DMs and groups are
//     refused without modifying anything;
//   - the post is inserted ONCE as a `messages` row (never duplicated per
//     follower);
//   - conversation_participants and conversations live in the same physical
//     host, so the row that pins the caller's role also pins the host used to
//     verify the conversation type and run the insert.
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';

export type PublishChannelPostResult =
  | { status: 'ok'; message: Record<string, unknown> }
  | { status: 'not_member' }
  | { status: 'not_channel' }
  | { status: 'not_publisher' };

export type ChannelPostPayload = {
  content?: string | null;
  imageUrl?: string | null;
  mediaUrl?: string | null;
  attachmentUrl?: string | null;
};

export async function publishChannelPost(
  conversationId: string,
  userId: string,
  payload: ChannelPostPayload
): Promise<PublishChannelPostResult> {
  if (!conversationId || !userId) return { status: 'not_member' };

  const participants = projectManager.getReadableProjects('conversation_participants');
  if (participants.length === 0) return { status: 'not_member' };

  // 1. Locate the caller's participant row and the conversation row. Sharded
  // hosts are tried in order; the first host that owns the conversation also
  // owns the participant rows (same DB). `conversations.created_by` is the
  // authoritative owner and MUST win over a stored role: the owner can hold a
  // stale `follower` participant row (legacy follows upserted the role), which
  // must never demote them to read-only.
  let role: string | null = null;
  let createdBy: string | null = null;
  let convType: string | null = null;
  let hostClient: SupabaseClient | null = null;
  for (const entry of participants) {
    try {
      const [{ data: participant }, { data: conv }] = await Promise.all([
        entry.client
          .from('conversation_participants')
          .select('role')
          .eq('conversation_id', conversationId)
          .eq('user_id', userId)
          .maybeSingle(),
        entry.client
          .from('conversations')
          .select('type, created_by')
          .eq('id', conversationId)
          .maybeSingle(),
      ]);
      if (conv) {
        convType = (conv as { type?: string | null }).type ?? null;
        createdBy = (conv as { created_by?: string | null }).created_by ?? null;
        if (!hostClient) hostClient = entry.client;
      }
      if (participant) {
        role = (participant as { role?: string }).role ?? null;
      }
      if (convType !== null || createdBy !== null) break;
    } catch {
      // Try the next readable host.
    }
  }
  if (!hostClient || !convType) return { status: 'not_member' };

  // 2. Only the owner/moderator may publish; followers are read/reply-only.
  //    The creator is always a publisher even when their participant row is
  //    missing or a stale follower row.
  const isOwner = createdBy === userId;
  const isPublisher = isOwner || role === 'owner' || role === 'moderator';
  if (!isOwner && !role) return { status: 'not_member' };
  if (!isPublisher) return { status: 'not_publisher' };

  // 3. Only channels can be published to.
  if (convType !== 'channel') return { status: 'not_channel' };

  // 4. Insert the post ONCE with the same classification the SPA uses for
  //    direct/group sends.
  const urlPath = payload.mediaUrl ? payload.mediaUrl.split('?')[0] : '';
  const isVideo = !!payload.mediaUrl && /\.(mp4|webm|ogg|mov|avi|mkv|m4v)$/i.test(urlPath);
  const isImage = !isVideo && !!payload.imageUrl;

  const { data, error } = await hostClient
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_id: userId,
      receiver_id: null,
      content: payload.content ?? null,
      attachment_url: payload.attachmentUrl ?? null,
      image_url: isImage ? payload.imageUrl : null,
      media_url: isVideo ? payload.mediaUrl : null,
      is_image: isImage,
      message_type: isVideo ? 'video' : isImage ? 'image' : 'text',
    })
    .select(`
      id,
      conversation_id,
      sender_id,
      content,
      encrypted_content,
      encryption_iv,
      attachment_url,
      image_url,
      media_url,
      is_image,
      message_type,
      reply_to_id,
      created_at,
      sender_profile:profiles!messages_sender_id_fkey(username, display_name, profile_pic)
    `)
    .single();
  if (error) throw new Error(`Failed to publish channel post: ${error.message}`);

  return { status: 'ok', message: data as Record<string, unknown> };
}