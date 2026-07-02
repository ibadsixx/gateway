import { StorageProvider, UploadResult } from './types';

export class R2Provider implements StorageProvider {
  async upload(path: string, _buffer: Buffer, mimeType: string): Promise<UploadResult> {
    console.log(`[Cloudflare R2] Uploading ${path} (${mimeType})`);
    return { url: `https://r2.cloudflarestorage.com/tone/${path}`, id: crypto.randomUUID() };
  }

  async delete(id: string): Promise<void> {
    console.log(`[Cloudflare R2] Deleting ${id}`);
  }

  async move(id: string, destination: string): Promise<void> {
    console.log(`[Cloudflare R2] Moving ${id} to ${destination}`);
  }

  async copy(id: string, destination: string): Promise<void> {
    console.log(`[Cloudflare R2] Copying ${id} to ${destination}`);
  }
}
