import { routingService } from '../../routing/service';
import { databaseRegistry } from '../../registry/databaseRegistry';
import type { DatabaseProject } from '../../registry/databaseRegistry';
import { getDatabaseProvider } from '../../providers/database';
import { connectionConfigFromProject } from '../../providers/database/types';
import type { DatabaseConnectionConfig } from '../../providers/database/types';
import { eventBus } from '../../events/bus';
import { metricsService } from '../../metrics';
import { RetryEngine } from '../../retry/engine';
import { createHash } from 'crypto';

interface QueryResult {
  id: string;
  [key: string]: unknown;
}

function getConfig(project: DatabaseProject): DatabaseConnectionConfig | undefined {
  return connectionConfigFromProject(project);
}

class DatabaseLayer {
  async read(domain: string, id: string): Promise<QueryResult | null> {
    const start = Date.now();
    try {
      const activeProjects = await databaseRegistry.getActiveProjects(domain);
      if (activeProjects.length === 0) {
        throw new Error(`No active projects for domain: ${domain}`);
      }
      const project = this.routeByHash(activeProjects, id);
      const config = getConfig(project);
      const provider = getDatabaseProvider(project.provider || 'supabase');
      const result = await RetryEngine.execute(() => provider.find(domain, id, config));
      metricsService.record('db.read.duration', Date.now() - start, { domain });
      return result;
    } catch (error) {
      metricsService.increment('db.read.errors', { domain });
      throw error;
    }
  }

  async write(domain: string, data: Record<string, unknown>): Promise<QueryResult> {
    const start = Date.now();
    try {
      const project = await routingService.getWritableProject(domain);
      const config = getConfig(project);
      const provider = getDatabaseProvider(project.provider || 'supabase');
      const result = await RetryEngine.execute(() => provider.create(domain, data, config));

      eventBus.emit({
        type: `${domain}.created`,
        payload: { id: result.id, data },
        metadata: { timestamp: new Date(), source: 'database-layer' },
      });

      metricsService.record('db.write.duration', Date.now() - start, { domain });
      return result;
    } catch (error) {
      metricsService.increment('db.write.errors', { domain });
      throw error;
    }
  }

  async update(domain: string, id: string, data: Record<string, unknown>): Promise<QueryResult> {
    const start = Date.now();
    try {
      const activeProjects = await databaseRegistry.getActiveProjects(domain);
      if (activeProjects.length === 0) {
        throw new Error(`No active projects for domain: ${domain}`);
      }
      const project = this.routeByHash(activeProjects, id);
      const config = getConfig(project);
      const provider = getDatabaseProvider(project.provider || 'supabase');
      const result = await RetryEngine.execute(() => provider.update(domain, id, data, config));

      eventBus.emit({
        type: `${domain}.updated`,
        payload: { id, data },
        metadata: { timestamp: new Date(), source: 'database-layer' },
      });

      metricsService.record('db.update.duration', Date.now() - start, { domain });
      return result;
    } catch (error) {
      metricsService.increment('db.update.errors', { domain });
      throw error;
    }
  }

  async delete(domain: string, id: string, permanent = false): Promise<void> {
    const start = Date.now();
    try {
      if (permanent) {
        const activeProjects = await databaseRegistry.getActiveProjects(domain);
        if (activeProjects.length === 0) {
          throw new Error(`No active projects for domain: ${domain}`);
        }
        const project = this.routeByHash(activeProjects, id);
        const config = getConfig(project);
        const provider = getDatabaseProvider(project.provider || 'supabase');
        await RetryEngine.execute(() => provider.delete(domain, id, config));
      } else {
        await this.update(domain, id, { deletedAt: new Date() } as Record<string, unknown>);
      }

      eventBus.emit({
        type: `${domain}.deleted`,
        payload: { id, permanent },
        metadata: { timestamp: new Date(), source: 'database-layer' },
      });

      metricsService.record('db.delete.duration', Date.now() - start, { domain });
    } catch (error) {
      metricsService.increment('db.delete.errors', { domain });
      throw error;
    }
  }

  async query(domain: string, filter: Record<string, unknown>): Promise<QueryResult[]> {
    const project = await routingService.getWritableProject(domain);
    const config = getConfig(project);
    const provider = getDatabaseProvider(project.provider || 'supabase');
    const results = await provider.query(domain, { ...filter, deletedAt: null }, config);
    return results;
  }

  private routeByHash(projects: DatabaseProject[], entityId: string): DatabaseProject {
    if (projects.length === 1) return projects[0];
    const hash = createHash('md5').update(entityId).digest('hex');
    const hashNum = parseInt(hash.substring(0, 8), 16);
    return projects[hashNum % projects.length];
  }
}

export const database = new DatabaseLayer();
