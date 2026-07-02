import { createHash } from 'crypto';

class ContentAddressing {
  private store: Map<string, { url: string; id: string }> = new Map();

  async address(buffer: Buffer): Promise<string> {
    return createHash('sha256').update(buffer).digest('hex');
  }

  async deduplicate(buffer: Buffer, uploadFn: () => Promise<{ url: string; id: string }>): Promise<{ url: string; id: string }> {
    const hash = await this.address(buffer);
    const existing = this.store.get(hash);
    if (existing) {
      console.log(`[ContentAddress] Reusing existing file with hash ${hash.substring(0, 12)}...`);
      return existing;
    }
    const result = await uploadFn();
    this.store.set(hash, result);
    return result;
  }

  isStored(hash: string): boolean {
    return this.store.has(hash);
  }
}

export const contentAddressing = new ContentAddressing();
