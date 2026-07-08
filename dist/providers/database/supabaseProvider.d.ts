import { DatabaseProvider, QueryResult, DatabaseConnectionConfig } from './types';
export declare class SupabaseProvider implements DatabaseProvider {
    private getClient;
    create(domain: string, data: Record<string, unknown>, config?: DatabaseConnectionConfig): Promise<QueryResult>;
    update(domain: string, id: string, data: Record<string, unknown>, config?: DatabaseConnectionConfig): Promise<QueryResult>;
    delete(domain: string, id: string, config?: DatabaseConnectionConfig): Promise<void>;
    find(domain: string, id: string, config?: DatabaseConnectionConfig): Promise<QueryResult | null>;
    query(domain: string, filter: Record<string, unknown>, config?: DatabaseConnectionConfig): Promise<QueryResult[]>;
}
//# sourceMappingURL=supabaseProvider.d.ts.map