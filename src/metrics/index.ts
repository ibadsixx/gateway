interface MetricPoint {
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: Date;
}

class MetricsService {
  private points: MetricPoint[] = [];
  private counters: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();

  increment(counter: string, labels: Record<string, string> = {}): void {
    const key = `${counter}:${JSON.stringify(labels)}`;
    this.counters.set(key, (this.counters.get(key) || 0) + 1);
    this.record(counter, this.counters.get(key)!, labels);
  }

  record(name: string, value: number, labels: Record<string, string> = {}): void {
    this.points.push({ name, value, labels, timestamp: new Date() });

    const histKey = `${name}:${JSON.stringify(labels)}`;
    if (!this.histograms.has(histKey)) {
      this.histograms.set(histKey, []);
    }
    this.histograms.get(histKey)!.push(value);

    const maxPoints = 10000;
    if (this.points.length > maxPoints) {
      this.points.splice(0, this.points.length - maxPoints);
    }
  }

  getCounter(name: string, labels: Record<string, string> = {}): number {
    const key = `${name}:${JSON.stringify(labels)}`;
    return this.counters.get(key) || 0;
  }

  getAverage(name: string, labels: Record<string, string> = {}): number {
    const key = `${name}:${JSON.stringify(labels)}`;
    const values = this.histograms.get(key);
    if (!values || values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  getSnapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      points: this.points.slice(-1000),
    };
  }
}

export const metricsService = new MetricsService();
