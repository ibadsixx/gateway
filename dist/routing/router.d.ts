declare class Router {
    private circuitBreakers;
    route(domain: string, entityId?: string): Promise<string>;
    private routeRead;
    private routeWrite;
    private selectByHash;
    private getProjectConnection;
    private getOrCreateCircuitBreaker;
}
export declare const router: Router;
export {};
//# sourceMappingURL=router.d.ts.map