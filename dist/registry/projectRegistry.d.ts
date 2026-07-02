import { DatabaseProject } from './databaseRegistry';
import { StorageAccount } from './storageRegistry';
declare class ProjectRegistry {
    findDatabaseProject(domain: string): Promise<DatabaseProject | undefined>;
    findStorageAccount(): Promise<StorageAccount | undefined>;
    updateDatabaseStatus(id: string, status: DatabaseProject['status']): Promise<void>;
    updateStorageUsage(id: string, usedSpace: number): Promise<void>;
    getInfrastructureStatus(): Promise<{
        databases: DatabaseProject[];
        storage: StorageAccount[];
    }>;
}
export declare const projectRegistry: ProjectRegistry;
export {};
//# sourceMappingURL=projectRegistry.d.ts.map