declare class Locator {
    private entries;
    register(entityId: string, projectId: string): void;
    locate(entityId: string): string | undefined;
    unregister(entityId: string): void;
}
export declare const locator: Locator;
export {};
//# sourceMappingURL=locator.d.ts.map