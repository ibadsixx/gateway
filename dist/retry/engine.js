"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetryEngine = void 0;
class RetryEngine {
    static async execute(fn, options = {}) {
        const { maxRetries = 3, baseDelay = 1000, maxDelay = 10000, onRetry } = options;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            }
            catch (error) {
                if (attempt === maxRetries)
                    throw error;
                const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
                const jitter = Math.random() * delay * 0.1;
                if (onRetry)
                    onRetry(attempt + 1, error);
                await new Promise(resolve => setTimeout(resolve, delay + jitter));
            }
        }
        throw new Error('RetryEngine: unreachable');
    }
}
exports.RetryEngine = RetryEngine;
//# sourceMappingURL=engine.js.map