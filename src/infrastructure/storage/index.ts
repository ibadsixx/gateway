import { projectRegistry } from '../../registry/projectRegistry';
import { storageRegistry } from '../../registry/storageRegistry';
import { getStorageProvider } from '../../providers/storage';
import { contentAddressing } from '../../media/contentAddress';
import { eventBus } from '../../events/bus';
import { mediaPipeline } from '../../media/pipeline';
import { jobQueue } from '../../jobs/queue';
import { generateId } from '../../utils';

interface UploadResult {
  url: string;
  id: string;
}

class StorageLayer {
  async upload(data: Record<string, unknown>): Promise<UploadResult> {
    const account = await projectRegistry.findStorageAccount();
    if (!account) throw new Error('No active storage account');

    const id = generateId();
    const provider = getStorageProvider(account.provider);

    let buffer: Buffer;
    if (data.buffer && typeof data.buffer === 'object') {
      buffer = Buffer.from(data.buffer as ArrayBuffer);
    } else {
      buffer = Buffer.from('placeholder');
    }

    const { url } = await contentAddressing.deduplicate(buffer, () =>
      provider.upload(`uploads/${id}`, buffer, (data.mimeType as string) || 'application/octet-stream'),
    );

    await storageRegistry.updateUsage(account.id, account.usedSpace + buffer.length);

    jobQueue.enqueue('media.process', {
      id,
      path: `uploads/${id}`,
      mimeType: data.mimeType || 'application/octet-stream',
    });

    eventBus.emit({
      type: 'media.uploaded',
      payload: { id, url, size: buffer.length },
      metadata: { timestamp: new Date(), source: 'storage-layer' },
    });

    return { url, id };
  }

  async delete(id: string): Promise<void> {
    const account = await projectRegistry.findStorageAccount();
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
