import { StorageProvider, UploadResult } from './types';

export class CloudinaryProvider implements StorageProvider {
  async upload(path: string, _buffer: Buffer, mimeType: string): Promise<UploadResult> {
    console.log(`[Cloudinary] Uploading ${path} (${mimeType})`);
    return { url: `https://res.cloudinary.com/tone/${path}`, id: crypto.randomUUID() };
  }

  async delete(id: string): Promise<void> {
    console.log(`[Cloudinary] Deleting ${id}`);
  }

  async move(id: string, destination: string): Promise<void> {
    console.log(`[Cloudinary] Moving ${id} to ${destination}`);
  }

  async copy(id: string, destination: string): Promise<void> {
    console.log(`[Cloudinary] Copying ${id} to ${destination}`);
  }
}
