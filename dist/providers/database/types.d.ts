export interface QueryResult {
    id: string;
    [key: string]: unknown;
}
export interface DatabaseConnectionConfig {
    projectUrl: string;
    serviceKey: string;
    anonKey: string;
}
export interface DatabaseProvider {
    create(domain: string, data: Record<string, unknown>, config?: DatabaseConnectionConfig): Promise<QueryResult>;
    update(domain: string, id: string, data: Record<string, unknown>, config?: DatabaseConnectionConfig): Promise<QueryResult>;
    delete(domain: string, id: string, config?: DatabaseConnectionConfig): Promise<void>;
    find(domain: string, id: string, config?: DatabaseConnectionConfig): Promise<QueryResult | null>;
    query(domain: string, filter: Record<string, unknown>, config?: DatabaseConnectionConfig): Promise<QueryResult[]>;
}
export declare function connectionConfigFromProject(project: {
    project_url?: string;
    service_key?: string;
    anon_key?: string;
    projectUrl?: string;
    serviceKey?: string;
    anonKey?: string;
}): DatabaseConnectionConfig | undefined;
//# sourceMappingURL=types.d.ts.map