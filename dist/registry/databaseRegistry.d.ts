export interface DatabaseProject {
    id: string;
    domain: string;
    provider: string;
    status: 'ACTIVE' | 'READ_ONLY' | 'DISABLED' | 'MAINTENANCE';
    priority: number;
    capacity: number;
    usedSpace: number;
    connectionName: string;
    projectUrl?: string;
    serviceKey?: string;
    anonKey?: string;
    region?: string;
    responseTime?: number;
    loadWeight?: number;
    writeEnabled?: boolean;
    healthStatus?: 'online' | 'degraded' | 'offline';
    lastHealthCheck?: Date;
}
declare class DatabaseRegistry {
    private cache;
    private cacheTimestamp;
    private readonly cacheTtl;
    private getCached;
    private invalidateCache;
    register(project: {
        id?: string;
        project_key?: string;
        domain: string;
        provider: string;
        status: DatabaseProject['status'];
        priority: number;
        capacity: number;
        usedSpace: number;
        connectionName?: string;
        projectUrl?: string;
        serviceKey?: string;
        anonKey?: string;
        loadWeight?: number;
        writeEnabled?: boolean;
    }): Promise<void>;
    getWritableProject(domain: string): Promise<DatabaseProject | undefined>;
    getActiveProjects(domain: string): Promise<DatabaseProject[]>;
    getActiveProject(domain: string): Promise<DatabaseProject | undefined>;
    getProjectById(id: string): Promise<DatabaseProject | undefined>;
    updateStatus(id: string, status: DatabaseProject['status']): Promise<void>;
    updateHealth(id: string, responseTime: number, usedSpace: number): Promise<void>;
    getAllProjects(): Promise<DatabaseProject[]>;
    getProjectsByDomain(domain: string): Promise<DatabaseProject[]>;
    private selectByLoad;
}
export declare const databaseRegistry: DatabaseRegistry;
export {};
//# sourceMappingURL=databaseRegistry.d.ts.map