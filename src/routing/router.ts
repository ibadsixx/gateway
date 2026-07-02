import { databaseRegistry, DatabaseProject } from '../registry/databaseRegistry';
import { infrastructureDb } from '../infrastructure/database/infrastructureDb';
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
    const writeTarget = await infrastructureDb.getCurrentWriteProject(domain);
    if (writeTarget) {
      const cb = this.getOrCreateCircuitBreaker(writeTarget.id);
      if (cb.getState() !== 'OPEN') {
        return this.getProjectConnection(domain, {
          id: writeTarget.id,
          domain: writeTarget.domain,
          provider: '',
          status: 'ACTIVE',
          priority: writeTarget.priority,
          capacity: writeTarget.capacity,
          usedSpace: writeTarget.used_space,
          connectionName: writeTarget.project_url,
          loadWeight: writeTarget.load_weight,
          lastHealthCheck: writeTarget.last_health_check ? new Date(writeTarget.last_health_check) : undefined,
        });
      }
    }

    const activeProjects = await databaseRegistry.getActiveProjects(domain);
    if (activeProjects.length === 0) {
      throw new Error(`No active projects available for domain: ${domain}`);
    }

    const selected = this.selectByLoad(activeProjects);
    return this.getProjectConnection(domain, selected);
  }

  private selectByHash(entityId: string, projects: DatabaseProject[]): DatabaseProject {
    const hash = createHash('md5').update(entityId).digest('hex');
    const hashNum = parseInt(hash.substring(0, 8), 16);
    const index = hashNum % projects.length;
    return projects[index];
  }

  private selectByLoad(projects: DatabaseProject[]): DatabaseProject {
    const withWeight = projects.map(p => ({
      project: p,
      weight: p.loadWeight ?? 1,
      capacityRatio: p.usedSpace / Math.max(p.capacity, 1),
    }));

    const adjustedWeights = withWeight.map(w => ({
      ...w,
      adjustedWeight: w.weight * (1 - w.capacityRatio),
    }));

    const totalAdjusted = adjustedWeights.reduce((s, w) => s + Math.max(w.adjustedWeight, 0.1), 0);
    let random = Math.random() * totalAdjusted;

    for (const w of adjustedWeights) {
      random -= Math.max(w.adjustedWeight, 0.1);
      if (random <= 0) return w.project;
    }

    return adjustedWeights[adjustedWeights.length - 1].project;
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
