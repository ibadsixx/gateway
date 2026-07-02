export interface UploadResult {
    url: string;
    id: string;
}
export interface StorageProvider {
    upload(path: string, buffer: Buffer, mimeType: string): Promise<UploadResult>;
    delete(id: string): Promise<void>;
    move(id: string, destination: string): Promise<void>;
    copy(id: string, destination: string): Promise<void>;
}
//# sourceMappingURL=types.d.ts.map