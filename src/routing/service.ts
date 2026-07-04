import { databaseRegistry } from '../registry/databaseRegistry';
import type { DatabaseProject } from '../registry/databaseRegistry';

class RoutingService {
  async getWritableProject(domain: string): Promise<DatabaseProject> {
    const project = await databaseRegistry.getWritableProject(domain);
    if (!project) {
      throw new Error(`No writable project found for domain: ${domain}`);
    }
    return project;
  }
}

export const routingService = new RoutingService();
