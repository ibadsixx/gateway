declare class FeatureFlags {
    private flags;
    enable(name: string): void;
    disable(name: string): void;
    isEnabled(name: string): boolean;
    getAll(): Record<string, boolean>;
}
export declare const featureFlags: FeatureFlags;
export {};
//# sourceMappingURL=index.d.ts.map