import { infrastructureDb } from '../infrastructure/database/infrastructureDb';
import type { InfrastructureProjectRow, ProjectStatus } from '../db/schema';

export interface DatabaseProject {
  id: string;
  domain: string;
  provider: string;
  status: 'ACTIVE' | 'READ_ONLY' | 'DISABLED' | 'MAINTENANCE';
  priority: number;
  capacity: number;
  usedSpace: number;
  connectionName: string;
  projectUrl?: string;
  serviceKey?: string;
  anonKey?: string;
  region?: string;
  responseTime?: number;
  loadWeight?: number;
  writeEnabled?: boolean;
  healthStatus?: 'online' | 'degraded' | 'offline';
  lastHealthCheck?: Date;
}

function toLegacyStatus(dbStatus: string): DatabaseProject['status'] {
  switch (dbStatus) {
    case 'active': return 'ACTIVE';
    case 'read_only': return 'READ_ONLY';
    case 'disabled': return 'DISABLED';
    case 'maintenance': return 'MAINTENANCE';
    default: return 'DISABLED';
  }
}

function toDbStatus(status: DatabaseProject['status']): ProjectStatus {
  switch (status) {
    case 'ACTIVE': return 'active';
    case 'READ_ONLY': return 'read_only';
    case 'DISABLED': return 'disabled';
    case 'MAINTENANCE': return 'maintenance';
  }
}

function toLegacyProject(row: InfrastructureProjectRow): DatabaseProject {
  return {
    id: row.id,
    domain: row.domain,
    provider: '',
    status: toLegacyStatus(row.status),
    priority: row.priority,
    capacity: row.capacity,
    usedSpace: row.used_space,
    connectionName: row.project_url,
    projectUrl: row.project_url || undefined,
    serviceKey: row.service_key || undefined,
    anonKey: row.anon_key || undefined,
    region: row.region || undefined,
    responseTime: row.response_time ?? undefined,
    loadWeight: row.load_weight,
    writeEnabled: row.write_enabled !== false,
    healthStatus: row.health_status || undefined,
    lastHealthCheck: row.last_health_check ? new Date(row.last_health_check) : undefined,
  };
}

class DatabaseRegistry {
  private cache: Map<string, DatabaseProject[]> = new Map();
  private cacheTimestamp = 0;
  private readonly cacheTtl = 5000;

  private async getCached(domain: string): Promise<DatabaseProject[]> {
    if (Date.now() - this.cacheTimestamp > this.cacheTtl) {
      this.cache.clear();
    }
    const key = `domain:${domain}`;
    if (!this.cache.has(key)) {
      const rows = await infrastructureDb.getProjects(domain);
      this.cache.set(key, rows.map(toLegacyProject));
      this.cacheTimestamp = Date.now();
    }
    return this.cache.get(key) || [];
  }

  private invalidateCache(): void {
    this.cache.clear();
  }

  async register(project: {
    id?: string;
    project_key?: string;
    domain: string;
    provider: string;
    status: DatabaseProject['status'];
    priority: number;
    capacity: number;
    usedSpace: number;
    connectionName?: string;
    projectUrl?: string;
    serviceKey?: string;
    anonKey?: string;
    loadWeight?: number;
    writeEnabled?: boolean;
  }): Promise<void> {
    const dbProviders = await infrastructureDb.getProviders();
    const providerRow = dbProviders.find(p => p.name.toLowerCase() === project.provider.toLowerCase())
      || dbProviders.find(p => p.type === 'database');

    await infrastructureDb.registerProject({
      project_key: (project.id || project.project_key || `${project.domain}_${Date.now()}`) as string,
      domain: project.domain,
      provider_id: providerRow?.id || crypto.randomUUID(),
      project_url: project.projectUrl || project.connectionName || '',
      service_key: project.serviceKey || '',
      anon_key: project.anonKey || '',
      status: toDbStatus(project.status),
      capacity: project.capacity,
      used_space: project.usedSpace,
      priority: project.priority,
      load_weight: project.loadWeight ?? 100,
      region: null,
      response_time: null,
      last_health_check: null,
    });

    const domain = await infrastructureDb.getDomain(project.domain);
    const dbProjects = await infrastructureDb.getProjects(project.domain);
    const activeProjects = dbProjects.filter(p => p.status === 'active');
    const firstActive = activeProjects.length > 0
      ? activeProjects.reduce((a, b) => a.priority <= b.priority ? a : b)
      : null;
    if (!domain) {
      await infrastructureDb.registerDomain({
        name: project.domain,
        current_write_project: firstActive?.id || null,
        next_project: null,
      });
    } else if (!domain.current_write_project && firstActive) {
      await infrastructureDb.setCurrentWriteProject(project.domain, firstActive.id);
    }

    this.invalidateCache();
  }

  async getWritableProject(domain: string): Promise<DatabaseProject | undefined> {
    const row = await infrastructureDb.getWritableProject(domain);
    return row ? toLegacyProject(row) : undefined;
  }

  async getActiveProjects(domain: string): Promise<DatabaseProject[]> {
    const rows = await infrastructureDb.getActiveProjects(domain);
    return rows.map(toLegacyProject);
  }

  async getActiveProject(domain: string): Promise<DatabaseProject | undefined> {
    const active = await this.getActiveProjects(domain);
    if (active.length === 0) return undefined;
    if (active.length === 1) return active[0];

    const writeTarget = await infrastructureDb.getCurrentWriteProject(domain);
    if (writeTarget) {
      const match = active.find(p => p.id === writeTarget.id);
      if (match) return match;
    }

    return this.selectByLoad(active);
  }

  async getProjectById(id: string): Promise<DatabaseProject | undefined> {
    const row = await infrastructureDb.getProjectById(id);
    return row ? toLegacyProject(row) : undefined;
  }

  async updateStatus(id: string, status: DatabaseProject['status']): Promise<void> {
    await infrastructureDb.updateProjectStatus(id, toDbStatus(status));
    this.invalidateCache();
  }

  async updateHealth(id: string, responseTime: number, usedSpace: number): Promise<void> {
    await infrastructureDb.updateProjectHealth(id, responseTime, usedSpace);
  }

  async getAllProjects(): Promise<DatabaseProject[]> {
    const rows = await infrastructureDb.getProjects();
    return rows.map(toLegacyProject);
  }

  async getProjectsByDomain(domain: string): Promise<DatabaseProject[]> {
    return this.getCached(domain);
  }

  private selectByLoad(projects: DatabaseProject[]): DatabaseProject {
    const now = Date.now();
    const recent = projects.filter(p => p.lastHealthCheck && now - p.lastHealthCheck.getTime() < 120000);
    const candidates = recent.length > 0 ? recent : projects;

    const totalWeight = candidates.reduce((sum, p) => sum + (p.loadWeight ?? 1), 0);
    let random = Math.random() * totalWeight;

    for (const project of candidates) {
      random -= project.loadWeight ?? 1;
      if (random <= 0) return project;
    }
    return candidates[candidates.length - 1];
  }
}

export const databaseRegistry = new DatabaseRegistry();
