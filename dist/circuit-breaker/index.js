"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreaker = void 0;
class CircuitBreaker {
    state = 'CLOSED';
    failures = 0;
    successes = 0;
    lastFailureTime = 0;
    config;
    constructor(config) {
        this.config = {
            failureThreshold: config?.failureThreshold ?? 5,
            successThreshold: config?.successThreshold ?? 2,
            timeout: config?.timeout ?? 30000,
        };
    }
    getState() {
        if (this.state === 'OPEN' && Date.now() - this.lastFailureTime >= this.config.timeout) {
            this.state = 'HALF_OPEN';
            this.successes = 0;
        }
        return this.state;
    }
    async call(fn) {
        if (this.getState() === 'OPEN') {
            throw new Error('Circuit breaker is OPEN');
        }
        try {
            const result = await fn();
            this.onSuccess();
            return result;
        }
        catch (error) {
            this.onFailure();
            throw error;
        }
    }
    onSuccess() {
        if (this.state === 'HALF_OPEN') {
            this.successes++;
            if (this.successes >= this.config.successThreshold) {
                this.state = 'CLOSED';
                this.failures = 0;
                this.successes = 0;
            }
        }
        else {
            this.failures = 0;
        }
    }
    onFailure() {
        this.lastFailureTime = Date.now();
        this.failures++;
        if (this.failures >= this.config.failureThreshold) {
            this.state = 'OPEN';
        }
    }
    reset() {
        this.state = 'CLOSED';
        this.failures = 0;
        this.successes = 0;
    }
}
exports.CircuitBreaker = CircuitBreaker;
//# sourceMappingURL=index.js.map