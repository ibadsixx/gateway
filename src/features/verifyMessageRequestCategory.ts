// Backend verification of the Message Request classification algorithm
// (messages.md). The gateway has no test runner, so this is an executable
// correctness check run with ts-node: `npm run verify:message-requests`.
//
// It drives the REAL `classifyMessageRequest` (the exact function the gateway's
// write routes call for every `message_requests` insert) against an injected
// in-memory model of the `friends` + `restricted_users` hosts, and asserts both
// required test cases end-to-end:
//
//   Test 1 — mutual friend: A not friends with B, shared friend C
//             friends(A) ∩ friends(B) = {C}  -> 'you_may_know' ("Maybe you know")
//   Test 2 — zero mutual friends: friends(A) ∩ friends(B) = {}  -> 'spam'
//
// It also asserts the spec's rule sharpness:
//   - the intersection is computed from the users' ACTUAL accepted-friendship
//     rows (both users' friend sets are queried; non-mutual friends are ignored),
//   - a PENDING friend request does NOT upgrade a zero-mutual pair to
//     'you_may_know' (followers/requests/etc. are not substitutes), and
//   - a restricted/blocked sender is ALWAYS 'spam' even with mutual friends.
import * as assert from 'node:assert';

import {
  classifyMessageRequest,
  type MessageRequestCategoryDeps,
} from './messageRequestCategory';

type FriendRow = { requester_id: string; receiver_id: string; status: 'pending' | 'accepted' };
type RestrictedRow = { user_id: string; restricted_user_id: string };

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
        if (f.requester_id === userId) ids.add(f.receiver_id);
        else if (f.receiver_id === userId) ids.add(f.requester_id);
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

async function main() {
  // --- Test 1 (messages.md): mutual friend -> Maybe-you-know -----------------
  {
    const deps = buildDeps({
      friends: [
        { requester_id: A, receiver_id: C, status: 'accepted' }, // A's friend
        { requester_id: B, receiver_id: C, status: 'accepted' }, // B's friend
        { requester_id: A, receiver_id: D, status: 'accepted' }, // extra, NOT mutual
      ],
      restricted: [],
    });
    const category = await classifyMessageRequest(A, B, deps);
    check('Test 1 [mutual friend A-C + B-C] -> you_may_know', category, 'you_may_know');
    check('Test 1: BOTH users\' accepted friends were queried', deps.friendQueries.includes(A) && deps.friendQueries.includes(B), true);
    check('Test 1: every accepted friendship of each user is part of the input', deps.friendQueries.length, 2);
  }

  // --- Test 2 (messages.md): zero mutual friends -> spam ---------------------
  {
    const deps = buildDeps({
      friends: [
        { requester_id: A, receiver_id: C, status: 'accepted' },
        { requester_id: B, receiver_id: D, status: 'accepted' },
        { requester_id: A, receiver_id: E, status: 'accepted' },
      ],
      restricted: [],
    });
    const category = await classifyMessageRequest(A, B, deps);
    check('Test 2 [disjoint friends {C,E} vs {D}] -> spam', category, 'spam');
  }

  // --- Spec sharpness: a PENDING friend request is NOT a substitute ----------
  {
    const deps = buildDeps({
      friends: [
        { requester_id: A, receiver_id: B, status: 'pending' }, // A->B pending request
      ],
      restricted: [],
    });
    const category = await classifyMessageRequest(A, B, deps);
    check('Spec: pending friend request alone does NOT upgrade to you_may_know', category, 'spam');
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
    const category = await classifyMessageRequest(A, B, deps);
    check('Restricted sender [mutual C but B restricted A] -> spam', category, 'spam');
  }

  // --- Degradation: an unavailable host never fails classification -----------
  {
    const failingDeps: MessageRequestCategoryDeps = {
      isRestricted: () => Promise.reject(new Error('host paused')),
      acceptedFriendIds: () => Promise.reject(new Error('host paused')),
    };
    const category = await classifyMessageRequest(A, B, failingDeps);
    check('Unavailable hosts degrade to spam (never throws)', category, 'spam');
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