export declare class RetryEngine {
    static execute<T>(fn: () => Promise<T>, options?: {
        maxRetries?: number;
        baseDelay?: number;
        maxDelay?: number;
        onRetry?: (attempt: number, error: Error) => void;
    }): Promise<T>;
}
//# sourceMappingURL=engine.d.ts.map