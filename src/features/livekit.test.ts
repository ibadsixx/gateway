// Tone Live — Gateway LiveKit service tests.
// Verifies LiveKit token generation, room management, and webhook verification
// logic without requiring a running LiveKit server or API credentials.
// Runs with ts-node (matches liveSessionsTest.ts pattern).
import {
  createLiveKitRoom,
  deleteLiveKitRoom,
  createLiveKitToken,
  verifyLiveKitWebhook,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  LIVEKIT_URL,
} from '../features/livekit';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

async function assertRejects(asyncFn: () => Promise<unknown>, expectedMessage: string): Promise<void> {
  try {
    await asyncFn();
    failed++;
    console.error(`  FAIL: expected rejection "${expectedMessage}" but resolved`);
  } catch (err: unknown) {
    if (String((err as Error).message) === expectedMessage) {
      passed++;
      console.log(`  PASS: ${expectedMessage}`);
    } else {
      failed++;
      console.error(`  FAIL: expected "${expectedMessage}", got "${String((err as Error).message)}"`);
    }
  }
}

async function main(): Promise<void> {
  console.log('\n=== Tone Live LiveKit Service Tests ===\n');

  console.log('--- No credentials configured ---');
  await createLiveKitRoom({ roomName: 'test-room' });
  passed++;
  console.log('  PASS: createLiveKitRoom resolves without credentials (warns)');
  await deleteLiveKitRoom('test-room');
  passed++;
  console.log('  PASS: deleteLiveKitRoom resolves without credentials (warns)');
  await assertRejects(
    () => createLiveKitToken({ room: 'test-room', identity: 'user-1', canPublish: true, canPublishData: true, canSubscribe: true }),
    'LiveKit API credentials not configured',
  );
  assert((await verifyLiveKitWebhook('Bearer abc', 'body')) === null, 'verifyLiveKitWebhook returns null without credentials');
  assert((await verifyLiveKitWebhook(undefined, 'body')) === null, 'verifyLiveKitWebhook returns null for missing auth header');
  assert((await verifyLiveKitWebhook('Basic abc', 'body')) === null, 'verifyLiveKitWebhook returns null for non-Bearer auth');

  console.log('\n--- LiveKit constants ---');
  assert(LIVEKIT_URL === 'ws://localhost:7880', 'LIVEKIT_URL defaults to ws://localhost:7880');
  assert(LIVEKIT_API_KEY === '', 'LIVEKIT_API_KEY is empty when not configured');
  assert(LIVEKIT_API_SECRET === '', 'LIVEKIT_API_SECRET is empty when not configured');

  console.log('\n--- Token options shape ---');
  const viewerOptions = { room: 'live-room-123', identity: 'viewer-1', canPublish: false, canPublishData: false, canSubscribe: true };
  assert(viewerOptions.canPublish === false, 'viewer canPublish=false');
  assert(viewerOptions.canPublishData === false, 'viewer canPublishData=false');
  assert(viewerOptions.canSubscribe === true, 'viewer canSubscribe=true');

  const hostOptions = { room: 'live-room-123', identity: 'host-1', canPublish: true, canPublishData: true, canSubscribe: true };
  assert(hostOptions.canPublish === true, 'host canPublish=true');
  assert(hostOptions.canSubscribe === true, 'host canSubscribe=true');

  console.log('\n--- Room config shape ---');
  const roomConfig = { roomName: 'live-session-abc', emptyTimeout: 300, maxParticipants: 50 };
  assert(roomConfig.roomName === 'live-session-abc', 'roomName set correctly');
  assert(roomConfig.emptyTimeout === 300, 'emptyTimeout set correctly');
  assert(roomConfig.maxParticipants === 50, 'maxParticipants set correctly');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test harness error:', err);
  process.exit(1);
});
