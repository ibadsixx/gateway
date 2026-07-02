interface ConfigValue {
    value: unknown;
    type: 'string' | 'number' | 'boolean' | 'json';
    updatedAt: Date;
}
declare class ConfigurationCenter {
    private cache;
    private loaded;
    ensureLoaded(): Promise<void>;
    set(key: string, value: unknown, type?: ConfigValue['type']): Promise<void>;
    get<T = unknown>(key: string, defaultValue?: T): T;
    watch(key: string, callback: (value: unknown) => void): void;
    getAll(): Promise<Record<string, unknown>>;
    private watchers;
    private notifyWatchers;
}
export declare const configCenter: ConfigurationCenter;
export {};
//# sourceMappingURL=index.d.ts.map