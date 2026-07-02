"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.distributedLock = void 0;
class DistributedLock {
    locks = new Map();
    async acquire(resource, holder, ttl = 5000) {
        const existing = this.locks.get(resource);
        if (existing) {
            if (Date.now() - existing.acquiredAt.getTime() > existing.ttl) {
                this.locks.delete(resource);
            }
            else {
                return false;
            }
        }
        this.locks.set(resource, { resource, holder, acquiredAt: new Date(), ttl });
        return true;
    }
    async release(resource, holder) {
        const lock = this.locks.get(resource);
        if (!lock || lock.holder !== holder)
            return false;
        this.locks.delete(resource);
        return true;
    }
    isLocked(resource) {
        const lock = this.locks.get(resource);
        if (!lock)
            return false;
        if (Date.now() - lock.acquiredAt.getTime() > lock.ttl) {
            this.locks.delete(resource);
            return false;
        }
        return true;
    }
}
exports.distributedLock = new DistributedLock();
//# sourceMappingURL=index.js.map