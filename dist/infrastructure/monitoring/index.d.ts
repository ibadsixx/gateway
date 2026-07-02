declare class MonitoringService {
    private interval?;
    start(intervalMs?: number): void;
    stop(): void;
    private check;
}
export declare const monitoring: MonitoringService;
export {};
//# sourceMappingURL=index.d.ts.map