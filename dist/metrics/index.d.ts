interface MetricPoint {
    name: string;
    value: number;
    labels: Record<string, string>;
    timestamp: Date;
}
declare class MetricsService {
    private points;
    private counters;
    private histograms;
    increment(counter: string, labels?: Record<string, string>): void;
    record(name: string, value: number, labels?: Record<string, string>): void;
    getCounter(name: string, labels?: Record<string, string>): number;
    getAverage(name: string, labels?: Record<string, string>): number;
    getSnapshot(): {
        counters: {
            [k: string]: number;
        };
        points: MetricPoint[];
    };
}
export declare const metricsService: MetricsService;
export {};
//# sourceMappingURL=index.d.ts.map