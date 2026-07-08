import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { ProjectInfo } from '../project-manager';

interface ClientConfig {
  projectUrl: string;
  serviceKey: string;
}

class ClientFactory {
  private clients = new Map<string, SupabaseClient>();

  private buildKey(config: ClientConfig): string {
    return `${config.projectUrl}:${config.serviceKey}`;
  }

  getClient(config: ClientConfig): SupabaseClient {
    const key = this.buildKey(config);
    if (!this.clients.has(key)) {
      this.clients.set(key, createClient(config.projectUrl, config.serviceKey));
    }
    return this.clients.get(key)!;
  }

  getClientFromProject(project: ProjectInfo): SupabaseClient {
    return this.getClient({
      projectUrl: project.projectUrl,
      serviceKey: project.serviceKey,
    });
  }

  removeClient(config: ClientConfig): void {
    this.clients.delete(this.buildKey(config));
  }

  clear(): void {
    this.clients.clear();
  }

  get size(): number {
    return this.clients.size;
  }
}

export const clientFactory = new ClientFactory();
