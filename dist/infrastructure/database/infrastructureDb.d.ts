import type { InfrastructureProjectRow, StorageProviderRow, DomainRow, GatewaySettingRow, HealthLogRow, ProviderRow, ProjectStatus, StorageStatus, ResourceType, SettingType } from '../../db/schema';
interface InfrastructureDbConfig {
    supabaseUrl?: string;
    supabaseKey?: string;
}
declare class InfrastructureDatabase {
    private client;
    private fallback;
    private fallbackProjects;
    private fallbackStorage;
    private fallbackDomains;
    private fallbackSettings;
    private fallbackHealthLogs;
    private fallbackProviders;
    private initialized;
    initialize(config?: InfrastructureDbConfig): Promise<void>;
    isInitialized(): boolean;
    getProviders(): Promise<ProviderRow[]>;
    getProviderByName(name: string): Promise<ProviderRow | null>;
    getProjects(domain?: string): Promise<InfrastructureProjectRow[]>;
    getActiveProjects(domain?: string): Promise<InfrastructureProjectRow[]>;
    getWritableProject(domain: string): Promise<InfrastructureProjectRow | null>;
    getProjectById(id: string): Promise<InfrastructureProjectRow | null>;
    getProjectByKey(key: string): Promise<InfrastructureProjectRow | null>;
    registerProject(project: Omit<InfrastructureProjectRow, 'id' | 'created_at' | 'updated_at'>): Promise<InfrastructureProjectRow>;
    updateProjectStatus(id: string, status: ProjectStatus): Promise<void>;
    updateProjectHealth(id: string, responseTime: number, usedSpace: number): Promise<void>;
    collectUsageMetrics(): Promise<void>;
    getStorageAccounts(): Promise<StorageProviderRow[]>;
    getActiveStorageAccounts(): Promise<StorageProviderRow[]>;
    getStorageAccountById(id: string): Promise<StorageProviderRow | null>;
    registerStorageAccount(account: Omit<StorageProviderRow, 'id' | 'created_at' | 'updated_at'>): Promise<StorageProviderRow>;
    updateStorageUsage(id: string, usedSpace: number): Promise<void>;
    updateStorageStatus(id: string, status: StorageStatus): Promise<void>;
    getDomain(name: string): Promise<DomainRow | null>;
    getAllDomains(): Promise<DomainRow[]>;
    getCurrentWriteProject(domain: string): Promise<InfrastructureProjectRow | null>;
    setCurrentWriteProject(domain: string, projectId: string): Promise<void>;
    registerDomain(domain: Omit<DomainRow, 'id' | 'created_at' | 'updated_at'>): Promise<DomainRow>;
    getSetting<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined>;
    getAllSettings(): Promise<GatewaySettingRow[]>;
    setSetting(key: string, value: unknown, type?: SettingType): Promise<void>;
    private settingWatchers;
    watchSetting(key: string, callback: (value: unknown) => void): void;
    private notifySettingWatchers;
    logHealth(entry: Omit<HealthLogRow, 'id' | 'checked_at'>): Promise<HealthLogRow>;
    getHealthLogs(resourceType?: ResourceType, resourceId?: string, limit?: number): Promise<HealthLogRow[]>;
    private initFallback;
}
export declare const infrastructureDb: InfrastructureDatabase;
export {};
//# sourceMappingURL=infrastructureDb.d.ts.map