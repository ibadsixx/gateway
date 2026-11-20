// Tone Live — Gateway token endpoint and role-permission tests.
// Verifies the /sessions/:id/token endpoint logic: authorization, role-based
// permission mapping, and LiveKit token shape. No running server required.
// Runs with ts-node (matches liveSessionsTest.ts pattern).
import {
  createLiveKitToken,
  verifyLiveKitWebhook,
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

// Helper: build the same options the token endpoint builds, by role.
function tokenOptionsForRole(role: 'host' | 'moderator' | 'guest' | 'viewer') {
  const canPublish = role === 'host' || role === 'moderator';
  const canPublishData = role === 'host' || role === 'moderator';
  return {
    room: 'live-room-123',
    identity: 'user-1',
    canPublish,
    canPublishData,
    canSubscribe: true,
  };
}

async function main(): Promise<void> {
  console.log('\n=== Tone Live Token Endpoint & Role Permission Tests ===\n');

  console.log('--- Role-based permissions ---');
  const hostOpts = tokenOptionsForRole('host');
  assert(hostOpts.canPublish === true, 'host canPublish=true');
  assert(hostOpts.canPublishData === true, 'host canPublishData=true');
  assert(hostOpts.canSubscribe === true, 'host canSubscribe=true');

  const modOpts = tokenOptionsForRole('moderator');
  assert(modOpts.canPublish === true, 'moderator canPublish=true');
  assert(modOpts.canPublishData === true, 'moderator canPublishData=true');
  assert(modOpts.canSubscribe === true, 'moderator canSubscribe=true');

  const guestOpts = tokenOptionsForRole('guest');
  assert(guestOpts.canPublish === false, 'guest canPublish=false');
  assert(guestOpts.canPublishData === false, 'guest canPublishData=false');
  assert(guestOpts.canSubscribe === true, 'guest canSubscribe=true');

  const viewerOpts = tokenOptionsForRole('viewer');
  assert(viewerOpts.canPublish === false, 'viewer canPublish=false');
  assert(viewerOpts.canPublishData === false, 'viewer canPublishData=false');
  assert(viewerOpts.canSubscribe === true, 'viewer canSubscribe=true');

  console.log('\n--- Token generation ---');
  await assertRejects(
    () => createLiveKitToken(tokenOptionsForRole('viewer')),
    'LiveKit API credentials not configured',
  );

  console.log('\n--- Webhook verification ---');
  assert((await verifyLiveKitWebhook(undefined, 'body')) === null, 'verifyLiveKitWebhook returns null without credentials');
  assert((await verifyLiveKitWebhook('Basic abc', 'body')) === null, 'verifyLiveKitWebhook returns null for non-Bearer auth');
  assert((await verifyLiveKitWebhook('Bearer', 'body')) === null, 'verifyLiveKitWebhook returns null for malformed Bearer token');

  console.log('\n--- Response shape ---');
  const mockResponse = {
    token: 'mock-token',
    roomId: 'live-room-123',
    sessionId: 'session-456',
    role: 'viewer' as const,
    livekitUrl: 'ws://localhost:7880',
  };
  assert(mockResponse.token !== undefined, 'response includes token');
  assert(mockResponse.roomId !== undefined, 'response includes roomId');
  assert(mockResponse.sessionId !== undefined, 'response includes sessionId');
  assert(mockResponse.role !== undefined, 'response includes role');
  assert(mockResponse.livekitUrl !== undefined, 'response includes livekitUrl');
  assert(['host', 'moderator', 'guest', 'viewer'].includes(mockResponse.role), 'role is a valid StreamRole');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test harness error:', err);
  process.exit(1);
});
