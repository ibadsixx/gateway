import { SupabaseClient } from '@supabase/supabase-js';
export interface ProjectInfo {
    id: string;
    projectKey: string;
    domain: string;
    providerId: string;
    projectUrl: string;
    serviceKey: string;
    anonKey: string;
    status: string;
    capacity: number;
    usedSpace: number;
    priority: number;
    loadWeight: number;
    writeEnabled: boolean;
    healthStatus: string | null;
    region: string | null;
    responseTime: number | null;
    lastHealthCheck: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface CachedProject {
    project: ProjectInfo;
    client: SupabaseClient;
}
declare class ProjectManager {
    private cache;
    load(): Promise<void>;
    refreshRegistry(): Promise<void>;
    getWritableProject(domain: string): CachedProject | null;
    getReadableProjects(domain: string): CachedProject[];
    getReadClient(domain: string, entityId: string): CachedProject;
    getProject(id: string): ProjectInfo | null;
    getProjects(domain?: string): ProjectInfo[];
    getProjectByKey(key: string): ProjectInfo | null;
    register(project: {
        projectKey?: string;
        domain: string;
        providerId: string;
        projectUrl: string;
        serviceKey: string;
        anonKey: string;
        status: string;
        capacity: number;
        usedSpace: number;
        priority: number;
        loadWeight?: number;
        region?: string | null;
    }): Promise<ProjectInfo>;
    updateStatus(id: string, status: string): Promise<void>;
    updateHealth(id: string, responseTime: number, usedSpace: number): Promise<void>;
}
export declare const projectManager: ProjectManager;
export {};
//# sourceMappingURL=index.d.ts.map