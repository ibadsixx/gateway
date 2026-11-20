// Tone Live — UNIT TESTS: signaling wire protocol validation.
// Runs with ts-node. No browser, network, or media server required.
//
// Covers:
//   - schema/type validation and unknown events
//   - payload size caps (SDP / ICE candidate / whole frame)
//   - client-supplied `fromUserId` stripping
//   - rate limiting and expiry-independent shape checks

import {
  validateClientSignalingMessage,
  SignalingRateLimiter,
  MAX_SIGNALING_MESSAGE_BYTES,
  MAX_SDP_BYTES,
  MAX_MESSAGES_PER_WINDOW,
} from './liveSignalingProtocol';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

function main(): void {
  console.log('=== Tone Live signaling protocol tests ===\n');

  console.log('--- valid messages ---');
  const offer = validateClientSignalingMessage(JSON.stringify({
    id: 'msg-1',
    sessionId: 'session-1',
    type: 'offer',
    toUserId: 'peer-2',
    sdp: 'v=0\r\n...',
    seq: 1,
  }));
  assert(offer.ok, 'valid offer accepted');
  if (offer.ok) {
    assert(offer.message.type === 'offer' && offer.message.sdp === 'v=0\r\n...', 'offer fields preserved');
  }

  const ice = validateClientSignalingMessage(JSON.stringify({
    id: 'msg-2',
    sessionId: 'session-1',
    type: 'ice-candidate',
    toUserId: 'peer-2',
    candidate: { sdpMid: '0', sdpMLineIndex: 0, candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host' },
  }));
  assert(ice.ok, 'valid ICE candidate accepted');

  const state = validateClientSignalingMessage(JSON.stringify({
    id: 'msg-3',
    sessionId: 'session-1',
    type: 'participant-state',
    state: { isMuted: true, raisedHand: true, role: 'guest', targetUserId: 'peer-2', ignored: 'drop-me' },
  }));
  assert(state.ok, 'valid participant-state accepted');
  if (state.ok) {
    assert(!('ignored' in (state.message.state ?? {})), 'unknown state keys are dropped');
    assert(state.message.state?.role === 'guest', 'role is allowed in state');
  }

  console.log('\n--- identity spoofing / unknown fields ---');
  const spoof = validateClientSignalingMessage(JSON.stringify({
    id: 'msg-4',
    sessionId: 'session-1',
    type: 'offer',
    fromUserId: 'someone-else',
    role: 'host',
    sdp: 'v=0',
  }));
  assert(spoof.ok, 'message with extra fields still parses');
  if (spoof.ok) {
    assert(!('fromUserId' in spoof.message), 'client-supplied fromUserId is stripped');
    assert(!('role' in spoof.message), 'client-supplied role is stripped');
  }

  console.log('\n--- malformed / oversized messages ---');
  assert(!validateClientSignalingMessage('not json').ok, 'invalid JSON rejected');
  assert(!validateClientSignalingMessage('[]').ok, 'array payload rejected');
  assert(!validateClientSignalingMessage(JSON.stringify({ id: '', sessionId: 's', type: 'offer' })).ok, 'empty id rejected');
  assert(!validateClientSignalingMessage(JSON.stringify({ id: 'x', sessionId: 's', type: 'join' })).ok,
    'server-only join event cannot be published by a client');
  assert(!validateClientSignalingMessage(JSON.stringify({ id: 'x', sessionId: 's', type: 'offer', sdp: '' })).ok,
    'empty SDP rejected');
  assert(!validateClientSignalingMessage(JSON.stringify({
    id: 'x', sessionId: 's', type: 'offer', sdp: 'a'.repeat(MAX_SDP_BYTES + 1),
  })).ok, 'oversized SDP rejected');
  assert(!validateClientSignalingMessage(JSON.stringify({
    id: 'x', sessionId: 's', type: 'offer', candidate: { candidate: 'x' },
  })).ok, 'candidate on an offer rejected');
  assert(!validateClientSignalingMessage('a'.repeat(MAX_SIGNALING_MESSAGE_BYTES + 1)).ok,
    'oversized frame rejected before JSON parsing');

  console.log('\n--- per-connection rate limit ---');
  const limiter = new SignalingRateLimiter();
  let now = 1_000_000;
  for (let i = 0; i < MAX_MESSAGES_PER_WINDOW; i++) assert(limiter.allow(now), `message ${i + 1} allowed`);
  assert(!limiter.allow(now), 'message over the limit rejected');
  now += 10_001;
  assert(limiter.allow(now), 'window reset allows a new message');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main();
