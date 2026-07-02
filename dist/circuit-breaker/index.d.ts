type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
interface CircuitConfig {
    failureThreshold: number;
    successThreshold: number;
    timeout: number;
}
declare class CircuitBreaker {
    private state;
    private failures;
    private successes;
    private lastFailureTime;
    private config;
    constructor(config?: Partial<CircuitConfig>);
    getState(): CircuitState;
    call<T>(fn: () => Promise<T>): Promise<T>;
    private onSuccess;
    private onFailure;
    reset(): void;
}
export { CircuitBreaker, CircuitState, CircuitConfig };
//# sourceMappingURL=index.d.ts.map