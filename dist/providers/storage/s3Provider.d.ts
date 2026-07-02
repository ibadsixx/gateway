import { StorageProvider, UploadResult } from './types';
export declare class S3Provider implements StorageProvider {
    upload(path: string, _buffer: Buffer, mimeType: string): Promise<UploadResult>;
    delete(id: string): Promise<void>;
    move(id: string, destination: string): Promise<void>;
    copy(id: string, destination: string): Promise<void>;
}
//# sourceMappingURL=s3Provider.d.ts.map