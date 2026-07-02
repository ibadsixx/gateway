export class RetryEngine {
  static async execute<T>(
    fn: () => Promise<T>,
    options: {
      maxRetries?: number;
      baseDelay?: number;
      maxDelay?: number;
      onRetry?: (attempt: number, error: Error) => void;
    } = {},
  ): Promise<T> {
    const { maxRetries = 3, baseDelay = 1000, maxDelay = 10000, onRetry } = options;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt === maxRetries) throw error;
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        const jitter = Math.random() * delay * 0.1;
        if (onRetry) onRetry(attempt + 1, error as Error);
        await new Promise(resolve => setTimeout(resolve, delay + jitter));
      }
    }

    throw new Error('RetryEngine: unreachable');
  }
}
