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
//
// IMPORTANT (messages.md): the category is decided ONLY from the number of
// UNIQUE users in the intersection friends(sender) ∩ friends(recipient):
//
//     mutual_friends_count > 0 -> 'you_may_know'
//     mutual_friends_count === 0 -> 'spam'
//
// There is NO fallback/default 'you_may_know'. A successful lookup that returns
// an empty array/object is still EXACTLY zero mutual friends -> 'spam'; an empty
// result is never treated as truthy.
export interface MutualFriendInput {
  senderFriendIds: Iterable<string>;
  receiverFriendIds: Iterable<string>;
  senderRestricted: boolean;
}

// The UNIQUE user ids shared by both users' ACTUAL accepted-friendship sets —
// directly the spec's `intersection(senderFriendIds, recipientFriendIds)`.
// Duplicate friendship rows (e.g. A->C plus C->A) yield one unique id.
export function mutualFriendIds(
  senderFriendIds: Iterable<string>,
  receiverFriendIds: Iterable<string>
): string[] {
  const receiver = new Set(receiverFriendIds);
  const unique = new Set<string>();
  for (const id of senderFriendIds) {
    if (typeof id === 'string' && receiver.has(id)) unique.add(id);
  }
  return [...unique];
}

export function classifyByMutualFriends(opts: MutualFriendInput): MessageRequestCategory {
  // A restricted/blocked sender is ALWAYS 'spam', even when both share friends.
  if (opts.senderRestricted) return 'spam';
  const mutual = mutualFriendIds(opts.senderFriendIds, opts.receiverFriendIds);
  return mutual.length > 0 ? 'you_may_know' : 'spam';
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
  // ONLY ACCEPTED friendships count (messages.md: pending / rejected /
  // cancelled requests, blocked users, followers/following and the two users
  // themselves are never mutual friends). The DB filter below restricts to
  // status = 'accepted'; the guards re-enforce it in code so a dropped/mangled
  // filter can never leak a non-accepted row, and the Set dedupes duplicate
  // friendship rows.
  async acceptedFriendIds(userId) {
    const entry = projectManager.getReadClient('friends', userId);
    const { data } = await entry.client
      .from('friends')
      .select('requester_id, receiver_id, status')
      .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
      .eq('status', 'accepted');
    const ids = new Set<string>();
    for (const f of (data || []) as Array<{ requester_id?: string; receiver_id?: string; status?: string }>) {
      if (!f) continue;
      if (f.status !== 'accepted') continue;
      const other = f.requester_id === userId ? f.receiver_id : f.requester_id;
      if (typeof other !== 'string' || other === userId) continue;
      ids.add(other);
    }
    return ids;
  },
};

export async function classifyMessageRequest(
  senderId: string,
  receiverId: string,
  deps: MessageRequestCategoryDeps = defaultDeps
): Promise<MessageRequestCategory> {
  if (!senderId || !receiverId || senderId === receiverId) {
    logClassification({
      sender_id: senderId,
      recipient_id: receiverId,
      sender_friend_ids: [],
      recipient_friend_ids: [],
      mutual_friend_ids: [],
      mutual_friends_count: 0,
      final_category: 'spam',
    });
    return 'spam';
  }

  try {
    const [senderRestricted, senderFriends, receiverFriends] = await Promise.all([
      deps.isRestricted(senderId, receiverId).catch(() => false),
      deps.acceptedFriendIds(senderId).catch(() => new Set<string>()),
      deps.acceptedFriendIds(receiverId).catch(() => new Set<string>()),
    ]);
    const senderFriendIds = [...senderFriends];
    const recipientFriendIds = [...receiverFriends];
    const shared = mutualFriendIds(senderFriendIds, recipientFriendIds);
    const category: MessageRequestCategory =
      senderRestricted || shared.length === 0 ? 'spam' : 'you_may_know';
    logClassification({
      sender_id: senderId,
      recipient_id: receiverId,
      sender_friend_ids: senderFriendIds,
      recipient_friend_ids: recipientFriendIds,
      mutual_friend_ids: shared,
      mutual_friends_count: shared.length,
      final_category: category,
    });
    return category;
  } catch {
    logClassification({
      sender_id: senderId,
      recipient_id: receiverId,
      sender_friend_ids: [],
      recipient_friend_ids: [],
      mutual_friend_ids: [],
      mutual_friends_count: 0,
      final_category: 'spam',
    });
    return 'spam';
  }
}

// Temporary diagnostic log (messages.md) for the mutual-friend calculation.
interface ClassificationLog {
  sender_id: string | null;
  recipient_id: string | null;
  sender_friend_ids: string[];
  recipient_friend_ids: string[];
  mutual_friend_ids: string[];
  mutual_friends_count: number;
  final_category: MessageRequestCategory;
}

function logClassification(fields: ClassificationLog): void {
  console.log('[Classification]', {
    sender_id: fields.sender_id,
    recipient_id: fields.recipient_id,
    sender_friend_ids: fields.sender_friend_ids,
    recipient_friend_ids: fields.recipient_friend_ids,
    mutual_friend_ids: fields.mutual_friend_ids,
    mutual_friends_count: fields.mutual_friends_count,
    final_category: fields.final_category,
  });
}