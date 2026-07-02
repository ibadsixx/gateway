declare class IdempotencyService {
    private records;
    process<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
    getResult<T>(key: string): T | null;
    invalidate(key: string): void;
    cleanup(): void;
}
export declare const idempotency: IdempotencyService;
export {};
//# sourceMappingURL=index.d.ts.map