import { projectManager, ProjectInfo } from '../project-manager';
import { infrastructureDb } from '../infrastructure/database/infrastructureDb';
import type { ProjectStatus } from '../db/schema';

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

function toLegacyProject(info: ProjectInfo): DatabaseProject {
  return {
    id: info.id,
    domain: info.domain,
    provider: '',
    status: toLegacyStatus(info.status),
    priority: info.priority,
    capacity: info.capacity,
    usedSpace: info.usedSpace,
    connectionName: info.projectUrl,
    projectUrl: info.projectUrl || undefined,
    serviceKey: info.serviceKey || undefined,
    anonKey: info.anonKey || undefined,
    region: info.region || undefined,
    responseTime: info.responseTime ?? undefined,
    loadWeight: info.loadWeight,
    writeEnabled: info.writeEnabled,
    healthStatus: (info.healthStatus as DatabaseProject['healthStatus']) || undefined,
    lastHealthCheck: info.lastHealthCheck ? new Date(info.lastHealthCheck) : undefined,
  };
}

class DatabaseRegistry {
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
    const dbProviders = await this.getProviders();
    const providerRow = dbProviders.find(p => p.name.toLowerCase() === project.provider.toLowerCase())
      || dbProviders.find(p => p.type === 'database');

    await projectManager.register({
      projectKey: project.id || project.project_key || `${project.domain}_${Date.now()}`,
      domain: project.domain,
      providerId: providerRow?.id || crypto.randomUUID(),
      projectUrl: project.projectUrl || project.connectionName || '',
      serviceKey: project.serviceKey || '',
      anonKey: project.anonKey || '',
      status: toDbStatus(project.status),
      capacity: project.capacity,
      usedSpace: project.usedSpace,
      priority: project.priority,
      loadWeight: project.loadWeight ?? 100,
    });

    const domainRow = await this.getDomain(project.domain);
    const allProjects = await projectManager.getProjects(project.domain);
    const activeProjects = allProjects.filter(p => p.status === 'active');
    const firstActive = activeProjects.length > 0
      ? activeProjects.reduce((a, b) => a.priority <= b.priority ? a : b)
      : null;
    if (!domainRow) {
      await this.registerDomain({
        name: project.domain,
        current_write_project: firstActive?.id || null,
      });
    } else if (!domainRow.current_write_project && firstActive) {
      await this.setCurrentWriteProject(project.domain, firstActive.id);
    }
  }

  async getWritableProject(domain: string): Promise<DatabaseProject | undefined> {
    const entry = projectManager.getWritableProject(domain);
    return entry ? toLegacyProject(entry.project) : undefined;
  }

  async getActiveProjects(domain: string): Promise<DatabaseProject[]> {
    const projects = projectManager.getReadableProjects(domain);
    return projects.map(e => toLegacyProject(e.project));
  }

  async getActiveProject(domain: string): Promise<DatabaseProject | undefined> {
    const active = await this.getActiveProjects(domain);
    if (active.length === 0) return undefined;
    if (active.length === 1) return active[0];

    const writeTarget = await this.getCurrentWriteProject(domain);
    if (writeTarget) {
      const match = active.find(p => p.id === writeTarget.id);
      if (match) return match;
    }

    return this.selectByLoad(active);
  }

  async getProjectById(id: string): Promise<DatabaseProject | undefined> {
    const info = await projectManager.getProject(id);
    return info ? toLegacyProject(info) : undefined;
  }

  async updateStatus(id: string, status: DatabaseProject['status']): Promise<void> {
    await projectManager.updateStatus(id, toDbStatus(status));
  }

  async updateHealth(id: string, responseTime: number, usedSpace: number): Promise<void> {
    await projectManager.updateHealth(id, responseTime, usedSpace);
  }

  async getAllProjects(): Promise<DatabaseProject[]> {
    const projects = await projectManager.getProjects();
    return projects.map(toLegacyProject);
  }

  async getProjectsByDomain(domain: string): Promise<DatabaseProject[]> {
    const projects = await projectManager.getProjects(domain);
    return projects.map(toLegacyProject);
  }

  private async getProviders() {
    return infrastructureDb.getProviders();
  }

  private async getDomain(name: string) {
    return infrastructureDb.getDomain(name);
  }

  private async registerDomain(data: { name: string; current_write_project: string | null }) {
    return infrastructureDb.registerDomain({
      name: data.name,
      current_write_project: data.current_write_project,
      next_project: null,
    });
  }

  private async setCurrentWriteProject(domain: string, projectId: string) {
    return infrastructureDb.setCurrentWriteProject(domain, projectId);
  }

  private async getCurrentWriteProject(domain: string) {
    return infrastructureDb.getCurrentWriteProject(domain);
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
