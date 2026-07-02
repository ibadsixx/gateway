interface ServiceInstance {
    name: string;
    version: string;
    endpoint: string;
    healthUrl: string;
    registeredAt: Date;
    lastHeartbeat: Date;
    metadata: Record<string, string>;
}
declare class ServiceDiscovery {
    private services;
    register(instance: ServiceInstance): void;
    unregister(name: string, endpoint: string): void;
    discover(name: string): ServiceInstance[];
    heartbeat(name: string, endpoint: string): boolean;
    getAllServices(): Record<string, ServiceInstance[]>;
}
export declare const serviceDiscovery: ServiceDiscovery;
export type { ServiceInstance };
//# sourceMappingURL=registry.d.ts.map