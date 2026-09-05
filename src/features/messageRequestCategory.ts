import { projectManager } from '../project-manager';

export type MessageRequestCategory = 'you_may_know' | 'spam';

// Gateway-owned Message Request categorization (messages.md).
//
// Friends and Conversations live in SEPARATE projects, so a database JOIN (or
// the DB trigger's `friends`/`restricted_users` references on the conversations
// host) is not reliable. The Gateway is the appropriate place to classify: it
// hides the project distribution and can query the `friends` host directly, and
// it is the single choke point through which every `message_requests` INSERT
// flows (routes.ts calls this BEFORE database.write).
//
// Exact spec semantics (messages.md "Category rules") — the stored value is the
// DB enum 'you_may_know' (displayed as "Maybe you know"):
//   - restricted/blocked sender           -> 'spam' (existing system behavior;
//       a blocked sender is ALWAYS spam, even when both share friends)
//   - NOT friends + >= 1 MUTUAL ACCEPTED friend -> 'you_may_know'
//   - NOT friends + zero mutual friends   -> 'spam'
//
// Mutual friendship means the INTERSECTION of the two users' actual accepted
// friendships: friends(S) ∩ friends(R). Followers, following, profile visits,
// likes, and a pending friend request are NOT substitutes (messages.md:
// "Do NOT use ... any other relationship as a substitute for mutual
// friendship"). The legacy "pending friend request -> you_may_know" rule is
// therefore intentionally NOT applied.
//
// The category is decided exactly ONCE — when the FIRST Message Request is
// created — and is then frozen (routes.ts also strips `category` from
// message_requests UPDATEs, so per-message sends can never re-classify).
//
// Never throws: any failure degrades to 'spam' so a classification problem can
// never fail a message send / request insert.

// The pure decision core, kept separate and dependency-free so the gateway can
// be verified (see verifyMessageRequestCategory.ts) and so the rule is exactly
// the messages.md algorithm.
export function classifyByMutualFriends(opts: {
  senderFriendIds: Iterable<string>;
  receiverFriendIds: Iterable<string>;
  senderRestricted: boolean;
}): MessageRequestCategory {
  if (opts.senderRestricted) return 'spam';
  const receiverFriends = new Set(opts.receiverFriendIds);
  for (const id of opts.senderFriendIds) {
    if (receiverFriends.has(id)) return 'you_may_know';
  }
  return 'spam';
}

export interface MessageRequestCategoryDeps {
  // True when `receiverId` has restricted/blocked `senderId`.
  isRestricted(senderId: string, receiverId: string): Promise<boolean>;
  // The OTHER side of every ACCEPTED friendship row involving `userId`.
  acceptedFriendIds(userId: string): Promise<Set<string>>;
}

// Default deps: real reads against the `friends` / `restricted_users` hosts via
// the project manager (stable hashing keeps a user pinned to one project).
const defaultDeps: MessageRequestCategoryDeps = {
  async isRestricted(senderId, receiverId) {
    const entry = projectManager.getReadClient('restricted_users', senderId);
    const { data } = await entry.client
      .from('restricted_users')
      .select('id')
      .eq('user_id', receiverId)
      .eq('restricted_user_id', senderId)
      .maybeSingle();
    return !!data;
  },
  async acceptedFriendIds(userId) {
    const entry = projectManager.getReadClient('friends', userId);
    const { data } = await entry.client
      .from('friends')
      .select('requester_id, receiver_id, status')
      .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
      .eq('status', 'accepted');
    const ids = new Set<string>();
    for (const f of (data || []) as Array<{ requester_id?: string; receiver_id?: string }>) {
      if (!f) continue;
      const other = f.requester_id === userId ? f.receiver_id : f.requester_id;
      if (typeof other === 'string') ids.add(other);
    }
    return ids;
  },
};

export async function classifyMessageRequest(
  senderId: string,
  receiverId: string,
  deps: MessageRequestCategoryDeps = defaultDeps
): Promise<MessageRequestCategory> {
  if (!senderId || !receiverId || senderId === receiverId) return 'spam';

  try {
    const [senderRestricted, senderFriends, receiverFriends] = await Promise.all([
      deps.isRestricted(senderId, receiverId).catch(() => false),
      deps.acceptedFriendIds(senderId).catch(() => new Set<string>()),
      deps.acceptedFriendIds(receiverId).catch(() => new Set<string>()),
    ]);
    return classifyByMutualFriends({
      senderFriendIds: senderFriends,
      receiverFriendIds: receiverFriends,
      senderRestricted,
    });
  } catch {
    return 'spam';
  }
}