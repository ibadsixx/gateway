import { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectInfo } from '../project-manager';
interface ClientConfig {
    projectUrl: string;
    serviceKey: string;
}
declare class ClientFactory {
    private clients;
    private buildKey;
    getClient(config: ClientConfig): SupabaseClient;
    getClientFromProject(project: ProjectInfo): SupabaseClient;
    removeClient(config: ClientConfig): void;
    clear(): void;
    get size(): number;
}
export declare const clientFactory: ClientFactory;
export {};
//# sourceMappingURL=index.d.ts.map