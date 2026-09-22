import assert from 'node:assert/strict';
import { infrastructureDb } from '../infrastructure/database/infrastructureDb';
import { storageRegistry } from '../registry/storageRegistry';
import { storage } from '../infrastructure/storage';

const CLOUD = 'test_cloud';
const KEY = 'test_key';
const SECRET = 'test_secret';

async function main(): Promise<void> {
  await infrastructureDb.initialize({ forceFallback: true });

  // Isolate the active cloudinary account: mark every existing fallback
  // account full so only the freshly-registered one (with real creds) returns.
  const existing = await storageRegistry.getAllAccounts();
  for (const a of existing) await storageRegistry.markFull(a.id);

  await storageRegistry.register({
    storageKey: 'cloudinary_resolve_test',
    provider: 'cloudinary',
    status: 'available' as const,
    capacity: 10000000000,
    usedSpace: 0,
    cloudName: CLOUD,
    apiKey: KEY,
    apiSecret: SECRET,
  });

  // Baseline: no format -> the plain reconstructed CDN asset (unchanged
  // behavior; gateway-fallback <img>/<audio> URLs keep rendering).
  const plain = await storage.resolvePublicUrl('user1/clip.webm');
  assert.ok(plain, 'resolvePublicUrl must resolve with an active account');
  assert.equal(
    plain.url,
    `https://res.cloudinary.com/${CLOUD}/video/upload/v1/tone/user1/clip.webm`
  );

  // Format conversion: 'mp3' inserts the f_mp3 transformation between
  // '/upload/' and the version, same public_id -> same asset, MP3 on delivery.
  const converted = await storage.resolvePublicUrl('user1/clip.webm', 'mp3');
  assert.equal(
    converted?.url,
    `https://res.cloudinary.com/${CLOUD}/video/upload/f_mp3/v1/tone/user1/clip.webm`
  );

  // Resource type inference still applies alongside the transformation.
  const image = await storage.resolvePublicUrl('user1/pic.jpg', 'mp3');
  assert.equal(
    image?.url,
    `https://res.cloudinary.com/${CLOUD}/image/upload/f_mp3/v1/tone/user1/pic.jpg`
  );

  // Sanitization: non-alphanumeric / empty format names must NOT reach the URL
  // (no transformation injection).
  const bad = await storage.resolvePublicUrl('user1/clip.webm', '../etc/passwd');
  assert.ok(bad, 'bad format must still resolve');
  assert.equal(
    bad.url,
    `https://res.cloudinary.com/${CLOUD}/video/upload/v1/tone/user1/clip.webm`,
    'unsafe format names must be ignored'
  );
  const empty = await storage.resolvePublicUrl('user1/clip.webm', '');
  assert.equal(
    empty?.url,
    `https://res.cloudinary.com/${CLOUD}/video/upload/v1/tone/user1/clip.webm`
  );

  console.log('storage resolve: all assertions passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});