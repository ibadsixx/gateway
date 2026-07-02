declare class DistributedLock {
    private locks;
    acquire(resource: string, holder: string, ttl?: number): Promise<boolean>;
    release(resource: string, holder: string): Promise<boolean>;
    isLocked(resource: string): boolean;
}
export declare const distributedLock: DistributedLock;
export {};
//# sourceMappingURL=index.d.ts.map