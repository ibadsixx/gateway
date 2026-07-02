import { DatabaseProvider, QueryResult, DatabaseConnectionConfig } from './types';
export declare class MongoProvider implements DatabaseProvider {
    create(domain: string, data: Record<string, unknown>, _config?: DatabaseConnectionConfig): Promise<QueryResult>;
    update(domain: string, id: string, data: Record<string, unknown>, _config?: DatabaseConnectionConfig): Promise<QueryResult>;
    delete(domain: string, id: string, _config?: DatabaseConnectionConfig): Promise<void>;
    find(domain: string, id: string, _config?: DatabaseConnectionConfig): Promise<QueryResult | null>;
    query(domain: string, filter: Record<string, unknown>, _config?: DatabaseConnectionConfig): Promise<QueryResult[]>;
}
//# sourceMappingURL=mongoProvider.d.ts.map