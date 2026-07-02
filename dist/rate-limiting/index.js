"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimiter = void 0;
class RateLimiter {
    buckets = new Map();
    configs = new Map();
    define(endpoint, config) {
        this.configs.set(endpoint, config);
    }
    check(endpoint, key) {
        const config = this.configs.get(endpoint);
        if (!config)
            return true;
        const bucketKey = `${endpoint}:${key}`;
        const now = Date.now();
        let bucket = this.buckets.get(bucketKey);
        if (!bucket || now >= bucket.resetAt) {
            bucket = { count: 0, resetAt: now + config.windowMs };
            this.buckets.set(bucketKey, bucket);
        }
        bucket.count++;
        return bucket.count <= config.maxRequests;
    }
    getRemaining(endpoint, key) {
        const config = this.configs.get(endpoint);
        if (!config)
            return Infinity;
        const bucket = this.buckets.get(`${endpoint}:${key}`);
        if (!bucket)
            return config.maxRequests;
        return Math.max(0, config.maxRequests - bucket.count);
    }
    reset(endpoint, key) {
        this.buckets.delete(`${endpoint}:${key}`);
    }
}
exports.rateLimiter = new RateLimiter();
//# sourceMappingURL=index.js.map