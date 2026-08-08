import { storageRegistry } from '../../registry/storageRegistry';
import { getStorageProvider } from '../../providers/storage';
import { StorageQuotaError } from '../../providers/storage/types';
import { eventBus } from '../../events/bus';
import { jobQueue } from '../../jobs/queue';
import { generateId } from '../../utils';

interface UploadResult {
  url: string;
  id: string;
}

interface UploadOptions {
  buffer?: unknown;
  mimeType?: string;
  bucket?: string;
  path?: string;
}

function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function toBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

class StorageLayer {
  async upload(data: UploadOptions = {}): Promise<UploadResult> {
    let buffer = toBuffer(data.buffer);
    if (!buffer || buffer.length === 0) {
      buffer = Buffer.from('placeholder');
    }

    const bucket = data.bucket || 'uploads';
    const path = data.path || `uploads/${generateId()}`;
    const mimeType = data.mimeType || 'application/octet-stream';

    const accounts = await storageRegistry.getActiveAccounts();
    if (accounts.length === 0) throw new Error('No active storage account');

    let lastError: Error | null = null;
    for (const account of shuffle(accounts)) {
      const provider = getStorageProvider(account.provider);
      try {
        const { url, id } = await provider.upload(path, buffer, mimeType, {
          cloudName: account.cloudName,
          apiKey: account.apiKey,
          apiSecret: account.apiSecret,
        });

        await storageRegistry.updateUsage(account.id, account.usedSpace + buffer.length);

        jobQueue.enqueue('media.process', {
          id,
          path: `${bucket}/${path}`,
          mimeType,
        });

        eventBus.emit({
          type: 'media.uploaded',
          payload: { id, url, size: buffer.length },
          metadata: { timestamp: new Date(), source: 'storage-layer' },
        });

        return { url, id };
      } catch (err) {
        if (err instanceof StorageQuotaError) {
          console.warn(`[Storage] Account ${account.id} is full; moving upload to another account: ${err.message}`);
          await storageRegistry.markFull(account.id);
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error('No storage account available');
  }

  async delete(id: string): Promise<void> {
    const account = await storageRegistry.getActiveAccount();
    if (!account) throw new Error('No active storage account');
    const provider = getStorageProvider(account.provider);
    await provider.delete(id);
  }

  async move(id: string, targetProvider: string): Promise<void> {
    const provider = getStorageProvider(targetProvider);
    await provider.move(id, targetProvider);
  }
}

export const storage = new StorageLayer();
