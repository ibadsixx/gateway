import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { infrastructureDb } from '../infrastructure/database/infrastructureDb';
import { storageRegistry } from '../registry/storageRegistry';
import { storage } from '../infrastructure/storage';
import { CloudinaryProvider } from '../providers/storage/cloudinaryProvider';

const CLOUD = 'test_cloud';
const KEY = 'test_key';
const SECRET = 'test_secret';
const PATH = 'user1/video.mp4';

function expectedSignature(timestamp: number): string {
  const canonical = [
    `folder=tone`,
    `public_id=${PATH}`,
    `timestamp=${timestamp}`,
  ].join('&');
  return createHash('sha1').update(`${canonical}${SECRET}`).digest('hex');
}

async function main(): Promise<void> {
  await infrastructureDb.initialize({ forceFallback: true });

  const provider = new CloudinaryProvider();
  const signed = provider.createSignedUploadParams(PATH, {
    cloudName: CLOUD,
    apiKey: KEY,
    apiSecret: SECRET,
  });

  assert.equal(signed.uploadUrl, `https://api.cloudinary.com/v1_1/${CLOUD}/auto/upload`);
  assert.equal(signed.cloudName, CLOUD);
  assert.equal(signed.apiKey, KEY);
  assert.equal(signed.folder, 'tone');
  assert.equal(signed.publicId, PATH);
  assert.match(signed.timestamp, /^\d{10}$/);
  assert.equal(signed.signature, expectedSignature(Number(signed.timestamp)), 'signature must match sha1 of sorted params + secret');

  // Isolate the active cloudinary account: mark every existing fallback
  // account full so only the freshly-registered one (with real creds) returns.
  const existing = await storageRegistry.getAllAccounts();
  for (const a of existing) await storageRegistry.markFull(a.id);

  await storageRegistry.register({
    storageKey: 'cloudinary_sign_test',
    provider: 'cloudinary',
    status: 'available' as const,
    capacity: 10000000000,
    usedSpace: 0,
    cloudName: CLOUD,
    apiKey: KEY,
    apiSecret: SECRET,
  });

  const layerSigned = await storage.createSignedUpload({ bucket: 'editor_videos', path: PATH });
  assert.equal(layerSigned.cloudName, CLOUD);
  assert.equal(layerSigned.folder, 'tone');
  assert.equal(layerSigned.publicId, PATH);
  assert.equal(layerSigned.signature, expectedSignature(Number(layerSigned.timestamp)));

  console.log('storage sign: all assertions passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});