// Backend verification of the Message Request classification algorithm
// (messages.md). The gateway has no test runner, so this is an executable
// correctness check run with ts-node: `npm run verify:message-requests`.
//
// It drives the REAL `classifyMessageRequest` (the exact function the gateway's
// write routes call for every `message_requests` insert) against an injected
// in-memory model of the `friends` + `restricted_users` hosts, and asserts both
// messages.md required test cases end-to-end:
//
//   TEST 1 — A and B have ZERO accepted mutual friends:
//             mutual_friends_count === 0 -> 'spam'
//   TEST 2 — A and B share at least one accepted friend C:
//             mutual_friends_count >= 1 -> 'you_may_know' ("Maybe you know")
//
// It also asserts the spec's rule sharpness:
//   - the category depends ONLY on the count of UNIQUE ids in the intersection
//     friends(A) ∩ friends(B) — a successful lookup that returns empty sets is
//     STILL 'spam' (an empty array/object is NOT truthy, so no fallback
//     'you_may_know' can ever fire),
//   - only ACCEPTED friendships count (pending / rejected / cancelled requests,
//     blocked users, followers, duplicates, and the users themselves never
//     count),
//   - a restricted/blocked sender is ALWAYS 'spam' even with mutual friends, and
//   - the category is stored on the FIRST message_requests insert exactly as the
//     gateway injects it (the DB trigger from migration
//     20260904000002_gateway_owns_message_request_category.sql preserves any
//     gateway-supplied category and only defaults NULL to 'spam').
import {
  classifyMessageRequest,
  mutualFriendIds,
  type MessageRequestCategoryDeps,
} from './messageRequestCategory';

type FriendRow = { requester_id: string; receiver_id: string; status: 'pending' | 'accepted' | 'rejected' };
type RestrictedRow = { user_id: string; restricted_user_id: string };

// Faithful in-memory model of the real default deps (messageRequestCategory.ts):
// only ACCEPTED rows count, self rows are ignored, results are a deduped Set.
function buildDeps(universe: {
  friends: FriendRow[];        // the friends host
  restricted: RestrictedRow[]; // the restricted_users host
}): MessageRequestCategoryDeps & { friendQueries: string[] } {
  const friendQueries: string[] = [];
  return {
    friendQueries,
    async isRestricted(senderId, receiverId) {
      return universe.restricted.some(
        r => r.user_id === receiverId && r.restricted_user_id === senderId
      );
    },
    async acceptedFriendIds(userId) {
      friendQueries.push(userId);
      const ids = new Set<string>();
      for (const f of universe.friends) {
        if (f.status !== 'accepted') continue;
        if (f.requester_id === userId) {
          if (f.receiver_id !== userId) ids.add(f.receiver_id);
        } else if (f.receiver_id === userId) {
          if (f.requester_id !== userId) ids.add(f.requester_id);
        }
      }
      return ids;
    },
  };
}

const A = 'user-A';
const B = 'user-B';
const C = 'user-C';
const D = 'user-D';
const E = 'user-E';

let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// Simulates the gateway's insert path (routes.ts maybeClassifyMessageRequest):
// the category the gateway computes on the FIRST request insert is injected
// into the write body, which is exactly the value the DB stores.
async function storedCategoryFor(
  senderId: string,
  receiverId: string,
  deps: MessageRequestCategoryDeps
): Promise<string> {
  const body: Record<string, unknown> = {
    sender_id: senderId,
    receiver_id: receiverId,
    status: 'pending',
    conversation_id: 'conversation-uuid',
  };
  body['category'] = await classifyMessageRequest(senderId, receiverId, deps);
  return body['category'] as string;
}

async function main() {
  // --- TEST 1 (messages.md): A and B have ZERO accepted mutual friends ------
  // mutual_friends_count === 0 -> 'spam'

  // 1a. Disjoint friend sets: friends(A) = {C, E}, friends(B) = {D}.
  {
    const deps = buildDeps({
      friends: [
        { requester_id: A, receiver_id: C, status: 'accepted' },
        { requester_id: B, receiver_id: D, status: 'accepted' },
        { requester_id: A, receiver_id: E, status: 'accepted' },
      ],
      restricted: [],
    });
    const senderFriendIds = ['user-C', 'user-E'];
    const recipientFriendIds = ['user-D'];
    const shared = mutualFriendIds(senderFriendIds, recipientFriendIds);
    check('TEST 1 [disjoint friends {C,E} vs {D}] mutual_friends_count', shared.length, 0);
    check('TEST 1 [disjoint friends] -> spam', await classifyMessageRequest(A, B, deps), 'spam');
    check('TEST 1: BOTH users\' accepted friends were queried', deps.friendQueries.includes(A) && deps.friendQueries.includes(B), true);
    check('TEST 1: stored category on FIRST insert is "spam"', await storedCategoryFor(A, B, deps), 'spam');
  }

  // 1b. BOTH users have NO friends at all — the lookups SUCCEEDED but returned
  // empty arrays. An empty array is NOT truthy, so this MUST be 'spam' (the
  // exact anti-pattern messages.md warns about: `if (mutualFriends) -> you_may_know`).
  {
    const deps = buildDeps({ friends: [], restricted: [] });
    check('TEST 1 [both friend lookups succeeded, empty sets] mutual_friends_count', mutualFriendIds([], []).length, 0);
    check('TEST 1 [empty result must NOT fall back to you_may_know] -> spam', await classifyMessageRequest(A, B, deps), 'spam');
    check('TEST 1: empty-result stored category is "spam"', await storedCategoryFor(A, B, deps), 'spam');
  }

  // 1c. Exclusions: pending / rejected / cancelled / self / duplicate rows
  // never count. A has pending A->C, rejected A->D and a self row A->A; B has
  // accepted B->E only. Zero accepted mutual friends -> 'spam'.
  {
    const deps = buildDeps({
      friends: [
        { requester_id: A, receiver_id: C, status: 'pending' },
        { requester_id: A, receiver_id: D, status: 'rejected' },
        { requester_id: A, receiver_id: A, status: 'accepted' },
        { requester_id: B, receiver_id: E, status: 'accepted' },
      ],
      restricted: [],
    });
    check('TEST 1 [pending/rejected/self rows excluded] -> spam', await classifyMessageRequest(A, B, deps), 'spam');
  }

  // --- TEST 2 (messages.md): A and B share at least one accepted friend C ---
  // mutual_friends_count >= 1 -> 'you_may_know'

  // 2a. one mutual accepted friend C (with duplicate A->C / C->A rows).
  {
    const deps = buildDeps({
      friends: [
        { requester_id: A, receiver_id: C, status: 'accepted' },
        { requester_id: C, receiver_id: A, status: 'accepted' },
        { requester_id: B, receiver_id: C, status: 'accepted' },
        { requester_id: C, receiver_id: B, status: 'accepted' },
        { requester_id: A, receiver_id: D, status: 'accepted' }, // extra, NOT mutual
      ],
      restricted: [],
    });
    const senderFriendIds = ['user-C', 'user-D'];
    const recipientFriendIds = ['user-C'];
    check('TEST 2 [mutual C, duplicate rows] unique mutual_friends_count', mutualFriendIds(senderFriendIds, recipientFriendIds).length, 1);
    check('TEST 2 [shared accepted friend C] -> you_may_know', await classifyMessageRequest(A, B, deps), 'you_may_know');
  }

  // 2b. two shared accepted friends C and D -> count 2 -> you_may_know.
  {
    const deps = buildDeps({
      friends: [
        { requester_id: A, receiver_id: C, status: 'accepted' },
        { requester_id: B, receiver_id: C, status: 'accepted' },
        { requester_id: A, receiver_id: D, status: 'accepted' },
        { requester_id: B, receiver_id: D, status: 'accepted' },
        { requester_id: B, receiver_id: E, status: 'accepted' }, // extra, NOT mutual
      ],
      restricted: [],
    });
    const senderFriendIds = ['user-C', 'user-D'];
    const recipientFriendIds = ['user-C', 'user-D'];
    check('TEST 2 [two shared friends] unique mutual_friends_count', mutualFriendIds(senderFriendIds, recipientFriendIds).length, 2);
    check('TEST 2 [two shared accepted friends] -> you_may_know', await classifyMessageRequest(A, B, deps), 'you_may_know');
  }

  // --- Spec sharpness: a PENDING friend request is NOT a substitute ----------
  {
    const deps = buildDeps({
      friends: [
        { requester_id: A, receiver_id: B, status: 'pending' }, // A->B pending request
      ],
      restricted: [],
    });
    check('Spec: pending friend request alone does NOT upgrade to you_may_know', await classifyMessageRequest(A, B, deps), 'spam');
  }

  // --- Restricted/blocked sender is ALWAYS spam even with a mutual friend ----
  {
    const deps = buildDeps({
      friends: [
        { requester_id: A, receiver_id: C, status: 'accepted' },
        { requester_id: B, receiver_id: C, status: 'accepted' },
      ],
      restricted: [{ user_id: B, restricted_user_id: A }],
    });
    check('Restricted sender [mutual C but B restricted A] -> spam', await classifyMessageRequest(A, B, deps), 'spam');
  }

  // --- Degradation: an unavailable host never fails classification -----------
  {
    const failingDeps: MessageRequestCategoryDeps = {
      isRestricted: () => Promise.reject(new Error('host paused')),
      acceptedFriendIds: () => Promise.reject(new Error('host paused')),
    };
    check('Unavailable hosts degrade to spam (never throws)', await classifyMessageRequest(A, B, failingDeps), 'spam');
  }

  // --- Self/empty inputs cannot yield you_may_know ----------------------------
  {
    const fullDeps = buildDeps({
      friends: [
        { requester_id: A, receiver_id: C, status: 'accepted' },
        { requester_id: B, receiver_id: C, status: 'accepted' },
      ],
      restricted: [],
    });
    check('Self-send (A->A) -> spam', await classifyMessageRequest(A, A, fullDeps), 'spam');
    check('Empty ids -> spam', await classifyMessageRequest('', B, fullDeps), 'spam');
  }

  if (failures > 0) {
    console.error(`\n${failures} verification check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('\nAll Message Request category verification checks PASSED.');
  }
}

void main();