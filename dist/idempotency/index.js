"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.idempotency = void 0;
class IdempotencyService {
    records = new Map();
    async process(key, ttlMs, fn) {
        const existing = this.records.get(key);
        if (existing && existing.expiresAt > new Date()) {
            return existing.result;
        }
        const result = await fn();
        this.records.set(key, {
            key,
            result,
            expiresAt: new Date(Date.now() + ttlMs),
        });
        return result;
    }
    getResult(key) {
        const record = this.records.get(key);
        if (!record || record.expiresAt <= new Date())
            return null;
        return record.result;
    }
    invalidate(key) {
        this.records.delete(key);
    }
    cleanup() {
        const now = new Date();
        for (const [key, record] of this.records) {
            if (record.expiresAt <= now) {
                this.records.delete(key);
            }
        }
    }
}
exports.idempotency = new IdempotencyService();
//# sourceMappingURL=index.js.map