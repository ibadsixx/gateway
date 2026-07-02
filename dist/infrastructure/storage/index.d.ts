interface UploadResult {
    url: string;
    id: string;
}
declare class StorageLayer {
    upload(data: Record<string, unknown>): Promise<UploadResult>;
    delete(id: string): Promise<void>;
    move(id: string, targetProvider: string): Promise<void>;
}
export declare const storage: StorageLayer;
export {};
//# sourceMappingURL=index.d.ts.map