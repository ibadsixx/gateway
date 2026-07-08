export interface QueryResult {
    id: string;
    [key: string]: unknown;
}
declare class RoutingService {
    write(domain: string, data: Record<string, unknown>): Promise<QueryResult>;
    read(domain: string, id: string): Promise<QueryResult | null>;
    update(domain: string, id: string, data: Record<string, unknown>): Promise<QueryResult>;
    delete(domain: string, id: string, permanent?: boolean): Promise<void>;
    query(domain: string, filter: Record<string, unknown>): Promise<QueryResult[]>;
}
export declare const routingService: RoutingService;
export {};
//# sourceMappingURL=service.d.ts.map