import { createHash } from 'crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { clientFactory } from '../client-factory';
import { infrastructureDb } from '../infrastructure/database/infrastructureDb';
import type { InfrastructureProjectRow, ProjectStatus } from '../db/schema';

export interface ProjectInfo {
  id: string;
  projectKey: string;
  domain: string;
  providerId: string;
  projectUrl: string;
  serviceKey: string;
  anonKey: string;
  status: string;
  capacity: number;
  usedSpace: number;
  priority: number;
  loadWeight: number;
  writeEnabled: boolean;
  healthStatus: string | null;
  region: string | null;
  responseTime: number | null;
  lastHealthCheck: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CachedProject {
  project: ProjectInfo;
  client: SupabaseClient;
}

function toProjectInfo(row: InfrastructureProjectRow): ProjectInfo {
  return {
    id: row.id,
    projectKey: row.project_key,
    domain: row.domain,
    providerId: row.provider_id,
    projectUrl: row.project_url,
    serviceKey: row.service_key,
    anonKey: row.anon_key,
    status: row.status,
    capacity: row.capacity,
    usedSpace: row.used_space,
    priority: row.priority,
    loadWeight: row.load_weight,
    writeEnabled: row.write_enabled !== false,
    healthStatus: row.health_status || null,
    region: row.region || null,
    responseTime: row.response_time ?? null,
    lastHealthCheck: row.last_health_check || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class ProjectManager {
  private cache: Map<string, CachedProject[]> = new Map();

  async load(): Promise<void> {
    const rows = await infrastructureDb.getProjects();
    const grouped = new Map<string, CachedProject[]>();
    for (const row of rows) {
      const project = toProjectInfo(row);
      const cached: CachedProject = {
        project,
        client: clientFactory.getClientFromProject(project),
      };
      const domain = row.domain;
      if (!grouped.has(domain)) grouped.set(domain, []);
      grouped.get(domain)!.push(cached);
    }
    this.cache = grouped;
  }

  async refreshRegistry(): Promise<void> {
    await this.load();
  }

  getWritableProject(domain: string): CachedProject | null {
    const entries = this.cache.get(domain);
    if (!entries) return null;
    const candidates = entries.filter(e =>
      e.project.writeEnabled
        && e.project.status === 'active'
        && e.project.healthStatus !== 'offline'
        && (e.project.capacity <= 0 || (e.project.usedSpace / e.project.capacity) * 100 < 90),
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => a.project.priority <= b.project.priority ? a : b);
  }

  getReadableProjects(domain: string): CachedProject[] {
    const entries = this.cache.get(domain);
    if (!entries) return [];
    return entries.filter(e => e.project.status === 'active');
  }

  getReadClient(domain: string, entityId: string): CachedProject {
    const projects = this.getReadableProjects(domain);
    if (projects.length === 0) {
      throw new Error(`No readable projects for domain: ${domain}`);
    }
    if (projects.length === 1) return projects[0];
    const hashNum = parseInt(createHash('md5').update(entityId).digest('hex').substring(0, 8), 16);
    return projects[hashNum % projects.length];
  }

  getProject(id: string): ProjectInfo | null {
    for (const entries of this.cache.values()) {
      const found = entries.find(e => e.project.id === id);
      if (found) return found.project;
    }
    return null;
  }

  getProjects(domain?: string): ProjectInfo[] {
    if (domain) {
      const entries = this.cache.get(domain);
      return entries ? entries.map(e => e.project) : [];
    }
    const all: ProjectInfo[] = [];
    for (const entries of this.cache.values()) {
      for (const e of entries) all.push(e.project);
    }
    return all;
  }

  getProjectByKey(key: string): ProjectInfo | null {
    for (const entries of this.cache.values()) {
      const found = entries.find(e => e.project.projectKey === key);
      if (found) return found.project;
    }
    return null;
  }

  async register(project: {
    projectKey?: string;
    domain: string;
    providerId: string;
    projectUrl: string;
    serviceKey: string;
    anonKey: string;
    status: string;
    capacity: number;
    usedSpace: number;
    priority: number;
    loadWeight?: number;
    region?: string | null;
  }): Promise<ProjectInfo> {
    const row = await infrastructureDb.registerProject({
      project_key: project.projectKey || `${project.domain}_${Date.now()}`,
      domain: project.domain,
      provider_id: project.providerId,
      project_url: project.projectUrl,
      service_key: project.serviceKey,
      anon_key: project.anonKey,
      status: project.status as ProjectStatus,
      capacity: project.capacity,
      used_space: project.usedSpace,
      priority: project.priority,
      load_weight: project.loadWeight ?? 100,
      region: project.region ?? null,
      response_time: null,
      last_health_check: null,
    });
    const info = toProjectInfo(row);
    const cached: CachedProject = {
      project: info,
      client: clientFactory.getClientFromProject(info),
    };
    if (!this.cache.has(info.domain)) this.cache.set(info.domain, []);
    this.cache.get(info.domain)!.push(cached);
    return info;
  }

  async updateStatus(id: string, status: string): Promise<void> {
    await infrastructureDb.updateProjectStatus(id, status as ProjectStatus);
    for (const entries of this.cache.values()) {
      const entry = entries.find(e => e.project.id === id);
      if (entry) {
        entry.project.status = status;
        entry.project.lastHealthCheck = new Date().toISOString();
        return;
      }
    }
  }

  async updateHealth(id: string, responseTime: number, usedSpace: number): Promise<void> {
    await infrastructureDb.updateProjectHealth(id, responseTime, usedSpace);
    for (const entries of this.cache.values()) {
      const entry = entries.find(e => e.project.id === id);
      if (entry) {
        entry.project.responseTime = responseTime;
        entry.project.usedSpace = usedSpace;
        entry.project.lastHealthCheck = new Date().toISOString();
        return;
      }
    }
  }

}

export const projectManager = new ProjectManager();
