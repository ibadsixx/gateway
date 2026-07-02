import { StorageProvider } from './types';
import { CloudinaryProvider } from './cloudinaryProvider';
import { S3Provider } from './s3Provider';
import { R2Provider } from './r2Provider';

const providers: Record<string, StorageProvider> = {
  cloudinary: new CloudinaryProvider(),
  s3: new S3Provider(),
  r2: new R2Provider(),
};

export function getStorageProvider(name: string): StorageProvider {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown storage provider: ${name}`);
  }
  return provider;
}

export { StorageProvider, CloudinaryProvider, S3Provider, R2Provider };
export type { UploadResult } from './types';
