interface IdempotencyRecord {
  key: string;
  result: unknown;
  expiresAt: Date;
}

class IdempotencyService {
  private records: Map<string, IdempotencyRecord> = new Map();

  async process<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const existing = this.records.get(key);
    if (existing && existing.expiresAt > new Date()) {
      return existing.result as T;
    }

    const result = await fn();
    this.records.set(key, {
      key,
      result,
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return result;
  }

  getResult<T>(key: string): T | null {
    const record = this.records.get(key);
    if (!record || record.expiresAt <= new Date()) return null;
    return record.result as T;
  }

  invalidate(key: string): void {
    this.records.delete(key);
  }

  cleanup(): void {
    const now = new Date();
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
      }
    }
  }
}

export const idempotency = new IdempotencyService();
