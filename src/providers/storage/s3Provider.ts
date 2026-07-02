import { StorageProvider, UploadResult } from './types';

export class S3Provider implements StorageProvider {
  async upload(path: string, _buffer: Buffer, mimeType: string): Promise<UploadResult> {
    console.log(`[AWS S3] Uploading ${path} (${mimeType})`);
    return { url: `https://s3.amazonaws.com/tone/${path}`, id: crypto.randomUUID() };
  }

  async delete(id: string): Promise<void> {
    console.log(`[AWS S3] Deleting ${id}`);
  }

  async move(id: string, destination: string): Promise<void> {
    console.log(`[AWS S3] Moving ${id} to ${destination}`);
  }

  async copy(id: string, destination: string): Promise<void> {
    console.log(`[AWS S3] Copying ${id} to ${destination}`);
  }
}
