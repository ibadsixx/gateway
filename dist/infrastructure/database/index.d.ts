interface QueryResult {
    id: string;
    [key: string]: unknown;
}
declare class DatabaseLayer {
    read(domain: string, id: string): Promise<QueryResult | null>;
    write(domain: string, data: Record<string, unknown>): Promise<QueryResult>;
    update(domain: string, id: string, data: Record<string, unknown>): Promise<QueryResult>;
    delete(domain: string, id: string, permanent?: boolean): Promise<void>;
    query(domain: string, filter: Record<string, unknown>): Promise<QueryResult[]>;
}
export declare const database: DatabaseLayer;
export {};
//# sourceMappingURL=index.d.ts.map