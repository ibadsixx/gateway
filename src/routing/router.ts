import { databaseRegistry, DatabaseProject } from '../registry/databaseRegistry';
import { CircuitBreaker } from '../circuit-breaker';
import { RetryEngine } from '../retry/engine';
import { createHash } from 'crypto';

class Router {
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();

  async route(domain: string, entityId?: string): Promise<string> {
    if (entityId) {
      return this.routeRead(domain, entityId);
    }
    return this.routeWrite(domain);
  }

  private async routeRead(domain: string, entityId: string): Promise<string> {
    const activeProjects = await databaseRegistry.getActiveProjects(domain);
    if (activeProjects.length === 0) {
      throw new Error(`No active projects available for domain: ${domain}`);
    }

    if (activeProjects.length === 1) {
      return activeProjects[0].id;
    }

    const selected = this.selectByHash(entityId, activeProjects);
    return this.getProjectConnection(domain, selected);
  }

  private async routeWrite(domain: string): Promise<string> {
    const project = await databaseRegistry.getWritableProject(domain);
    if (!project) {
      throw new Error(`No writable project found for domain: ${domain}`);
    }
    return project.id;
  }

  private selectByHash(entityId: string, projects: DatabaseProject[]): DatabaseProject {
    const hash = createHash('md5').update(entityId).digest('hex');
    const hashNum = parseInt(hash.substring(0, 8), 16);
    const index = hashNum % projects.length;
    return projects[index];
  }

  private async getProjectConnection(domain: string, project: DatabaseProject): Promise<string> {
    const cb = this.getOrCreateCircuitBreaker(project.id);

    return RetryEngine.execute(async () => {
      return cb.call(async () => {
        await databaseRegistry.updateHealth(project.id, Math.random() * 100, project.usedSpace);
        return project.id;
      });
    }, {
      maxRetries: 2,
      onRetry: async (_attempt, _error) => {
        const active = await databaseRegistry.getActiveProjects(domain);
        const next = active.find(p => p.id !== project.id);
        if (next) {
          project.id = next.id;
        }
      },
    });
  }

  private getOrCreateCircuitBreaker(projectId: string): CircuitBreaker {
    if (!this.circuitBreakers.has(projectId)) {
      this.circuitBreakers.set(projectId, new CircuitBreaker({
        failureThreshold: 5,
        successThreshold: 2,
        timeout: 30000,
      }));
    }
    return this.circuitBreakers.get(projectId)!;
  }
}

export const router = new Router();
