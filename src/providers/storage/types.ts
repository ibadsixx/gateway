export interface UploadResult {
  url: string;
  id: string;
}

export interface UploadCredentials {
  cloudName?: string;
  apiKey?: string;
  apiSecret?: string;
}

export class StorageQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

export interface StorageProvider {
  upload(path: string, buffer: Buffer, mimeType: string, credentials?: UploadCredentials): Promise<UploadResult>;
  delete(id: string): Promise<void>;
  move(id: string, destination: string): Promise<void>;
  copy(id: string, destination: string): Promise<void>;
}
