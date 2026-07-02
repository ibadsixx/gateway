export interface StorageAccount {
    id: string;
    provider: string;
    status: 'ACTIVE' | 'DISABLED' | 'MAINTENANCE';
    capacity: number;
    usedSpace: number;
    priority: number;
    region?: string;
    responseTime?: number;
}
declare class StorageRegistry {
    register(account: {
        id?: string;
        provider_key?: string;
        provider: string;
        status: StorageAccount['status'];
        capacity: number;
        usedSpace: number;
        priority: number;
    }): Promise<void>;
    getActiveAccounts(): Promise<StorageAccount[]>;
    getActiveAccount(): Promise<StorageAccount | undefined>;
    updateUsage(id: string, usedSpace: number): Promise<void>;
    updateStatus(id: string, status: StorageAccount['status']): Promise<void>;
    getAllAccounts(): Promise<StorageAccount[]>;
}
export declare const storageRegistry: StorageRegistry;
export {};
//# sourceMappingURL=storageRegistry.d.ts.map