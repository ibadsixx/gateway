interface SearchResult {
    id: string;
    score: number;
    domain: string;
    data: Record<string, unknown>;
}
declare class SearchService {
    private indices;
    private documents;
    registerIndex(domain: string, field: string): void;
    index(domain: string, id: string, data: Record<string, unknown>): Promise<void>;
    search(domain: string, query: string): Promise<SearchResult[]>;
    remove(domain: string, id: string): Promise<void>;
}
export declare const searchService: SearchService;
export {};
//# sourceMappingURL=index.d.ts.map