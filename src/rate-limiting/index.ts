interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

class RateLimiter {
  private buckets: Map<string, { count: number; resetAt: number }> = new Map();
  private configs: Map<string, RateLimitConfig> = new Map();

  define(endpoint: string, config: RateLimitConfig): void {
    this.configs.set(endpoint, config);
  }

  check(endpoint: string, key: string): boolean {
    const config = this.configs.get(endpoint);
    if (!config) return true;

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

  getRemaining(endpoint: string, key: string): number {
    const config = this.configs.get(endpoint);
    if (!config) return Infinity;
    const bucket = this.buckets.get(`${endpoint}:${key}`);
    if (!bucket) return config.maxRequests;
    return Math.max(0, config.maxRequests - bucket.count);
  }

  reset(endpoint: string, key: string): void {
    this.buckets.delete(`${endpoint}:${key}`);
  }
}

export const rateLimiter = new RateLimiter();
