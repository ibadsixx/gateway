interface Lock {
  resource: string;
  holder: string;
  acquiredAt: Date;
  ttl: number;
}

class DistributedLock {
  private locks: Map<string, Lock> = new Map();

  async acquire(resource: string, holder: string, ttl = 5000): Promise<boolean> {
    const existing = this.locks.get(resource);
    if (existing) {
      if (Date.now() - existing.acquiredAt.getTime() > existing.ttl) {
        this.locks.delete(resource);
      } else {
        return false;
      }
    }
    this.locks.set(resource, { resource, holder, acquiredAt: new Date(), ttl });
    return true;
  }

  async release(resource: string, holder: string): Promise<boolean> {
    const lock = this.locks.get(resource);
    if (!lock || lock.holder !== holder) return false;
    this.locks.delete(resource);
    return true;
  }

  isLocked(resource: string): boolean {
    const lock = this.locks.get(resource);
    if (!lock) return false;
    if (Date.now() - lock.acquiredAt.getTime() > lock.ttl) {
      this.locks.delete(resource);
      return false;
    }
    return true;
  }
}

export const distributedLock = new DistributedLock();
