interface RateLimitConfig {
    windowMs: number;
    maxRequests: number;
}
declare class RateLimiter {
    private buckets;
    private configs;
    define(endpoint: string, config: RateLimitConfig): void;
    check(endpoint: string, key: string): boolean;
    getRemaining(endpoint: string, key: string): number;
    reset(endpoint: string, key: string): void;
}
export declare const rateLimiter: RateLimiter;
export {};
//# sourceMappingURL=index.d.ts.map