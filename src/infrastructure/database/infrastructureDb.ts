import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type {
  InfrastructureProjectRow,
  StorageProviderRow,
  DomainRow,
  GatewaySettingRow,
  HealthLogRow,
  ProviderRow,
  ProjectStatus,
  StorageStatus,
  HealthStatus,
  ResourceType,
  SettingType,
} from '../../db/schema';

interface InfrastructureDbConfig {
  supabaseUrl?: string;
  supabaseKey?: string;
  forceFallback?: boolean;
}

class InfrastructureDatabase {
  private client: SupabaseClient | null = null;
  private fallback = true;

  private fallbackProjects: InfrastructureProjectRow[] = [];
  private fallbackStorage: StorageProviderRow[] = [];
  private fallbackDomains: DomainRow[] = [];
  private fallbackSettings: Map<string, GatewaySettingRow> = new Map();
  private fallbackHealthLogs: HealthLogRow[] = [];
  private fallbackProviders: ProviderRow[] = [];
  private initialized = false;

  async initialize(config?: InfrastructureDbConfig): Promise<void> {
    if (config?.forceFallback) {
      console.warn('[InfrastructureDB] Forced fallback mode.');
      this.fallback = true;
      this.initFallback();
      this.initialized = true;
      return;
    }

    const url = config?.supabaseUrl || process.env.INFRA_SUPABASE_URL;
    const key = config?.supabaseKey || process.env.INFRA_SUPABASE_KEY;

    if (url && key) {
      this.client = createClient(url, key);
      this.fallback = false;
    } else {
      console.warn('[InfrastructureDB] No Supabase credentials found. Using in-memory fallback.');
      this.fallback = true;
      this.initFallback();
    }

    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // ---- Providers ----

  async getProviders(): Promise<ProviderRow[]> {
    if (this.fallback) return [...this.fallbackProviders];
    const { data, error } = await this.client!.from('providers').select('*');
    if (error) throw new Error(`Failed to fetch providers: ${error.message}`);
    return (data as ProviderRow[]) || [];
  }

  async getProviderByName(name: string): Promise<ProviderRow | null> {
    if (this.fallback) return this.fallbackProviders.find(p => p.name === name) || null;
    const { data, error } = await this.client!.from('providers').select('*').eq('name', name).single();
    if (error && error.code !== 'PGRST116') throw new Error(`Failed to fetch provider: ${error.message}`);
    return (data as ProviderRow) || null;
  }

  // ---- Infrastructure Projects ----

  async getProjects(domain?: string): Promise<InfrastructureProjectRow[]> {
    if (this.fallback) {
      let projects = [...this.fallbackProjects];
      if (domain) projects = projects.filter(p => p.domain === domain);
      return projects;
    }
    let query = this.client!.from('infrastructure_projects').select('*');
    if (domain) query = query.eq('domain', domain);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to fetch projects: ${error.message}`);
    return (data as InfrastructureProjectRow[]) || [];
  }

  async getActiveProjects(domain?: string): Promise<InfrastructureProjectRow[]> {
    const projects = await this.getProjects(domain);
    return projects.filter(p => p.status === 'active');
  }

  async getWritableProject(domain: string): Promise<InfrastructureProjectRow | null> {
    if (this.fallback) {
      const candidates = this.fallbackProjects.filter(p =>
        p.domain === domain && p.write_enabled && p.status === 'active'
          && p.health_status !== 'offline'
          && (p.capacity <= 0 || (p.used_space / p.capacity) * 100 < 90),
      );
      return candidates.sort((a, b) => a.priority - b.priority)[0] || null;
    }
    let { data, error } = await this.client!.from('infrastructure_projects')
      .select('*')
      .eq('domain', domain)
      .eq('status', 'active')
      .eq('write_enabled', true)
      .eq('health_status', 'online')
      .order('priority', { ascending: true })
      .limit(10);
    if (error?.code === 'PGRST204') {
      ({ data, error } = await this.client!.from('infrastructure_projects')
        .select('*')
        .eq('domain', domain)
        .eq('status', 'active')
        .eq('write_enabled', true)
        .order('priority', { ascending: true })
        .limit(10));
    }
    if (error) throw new Error(`Failed to fetch writable project: ${error.message}`);

    const projects = (data as InfrastructureProjectRow[]) || [];
    if (projects.length === 0) return null;

    const healthy = projects.filter(p =>
      p.capacity <= 0 || (p.used_space / p.capacity) * 100 < 90,
    );

    return healthy[0] || projects[0];
  }

  async getProjectById(id: string): Promise<InfrastructureProjectRow | null> {
    if (this.fallback) return this.fallbackProjects.find(p => p.id === id) || null;
    const { data, error } = await this.client!.from('infrastructure_projects').select('*').eq('id', id).single();
    if (error && error.code !== 'PGRST116') throw new Error(`Failed to fetch project: ${error.message}`);
    return (data as InfrastructureProjectRow) || null;
  }

  async getProjectByKey(key: string): Promise<InfrastructureProjectRow | null> {
    if (this.fallback) return this.fallbackProjects.find(p => p.project_key === key) || null;
    const { data, error } = await this.client!.from('infrastructure_projects').select('*').eq('project_key', key).single();
    if (error && error.code !== 'PGRST116') throw new Error(`Failed to fetch project by key: ${error.message}`);
    return (data as InfrastructureProjectRow) || null;
  }

  async registerProject(project: Omit<InfrastructureProjectRow, 'id' | 'created_at' | 'updated_at'>): Promise<InfrastructureProjectRow> {
    if (this.fallback) {
      const row: InfrastructureProjectRow = {
        id: crypto.randomUUID(),
        ...project,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const existing = this.fallbackProjects.findIndex(p => p.project_key === row.project_key);
      if (existing >= 0) {
        this.fallbackProjects[existing] = row;
      } else {
        this.fallbackProjects.push(row);
      }
      this.fallbackProjects.sort((a, b) => a.priority - b.priority);
      return row;
    }
    const { data, error } = await this.client!.from('infrastructure_projects').insert(project).select().single();
    if (error) throw new Error(`Failed to register project: ${error.message}`);
    return data as InfrastructureProjectRow;
  }

  async updateProjectStatus(id: string, status: ProjectStatus): Promise<void> {
    const update: Partial<InfrastructureProjectRow> = { status, last_health_check: new Date().toISOString() };
    if (this.fallback) {
      const project = this.fallbackProjects.find(p => p.id === id);
      if (project) {
        project.status = status;
        project.last_health_check = update.last_health_check!;
      }
      return;
    }
    const { error } = await this.client!.from('infrastructure_projects').update(update).eq('id', id);
    if (error) throw new Error(`Failed to update project status: ${error.message}`);
  }

  async updateProjectHealth(id: string, responseTime: number, usedSpace: number): Promise<void> {
    const update: Partial<InfrastructureProjectRow> = {
      response_time: responseTime,
      used_space: usedSpace,
      last_health_check: new Date().toISOString(),
    };
    if (this.fallback) {
      const project = this.fallbackProjects.find(p => p.id === id);
      if (project) {
        project.response_time = responseTime;
        project.used_space = usedSpace;
        project.last_health_check = update.last_health_check!;
      }
      return;
    }
    const { error } = await this.client!.from('infrastructure_projects').update(update).eq('id', id);
    if (error) throw new Error(`Failed to update project health: ${error.message}`);
  }

  async collectUsageMetrics(): Promise<void> {
    if (this.fallback) return;
    const { data, error } = await this.client!.from('infrastructure_projects')
      .select('id, project_key, domain, project_url, management_pat')
      .not('management_pat', 'is', null)
      .like('project_url', 'https://%.supabase.co');
    if (error) {
      console.error('[InfrastructureDB] Failed to fetch projects for metrics:', error.message);
      return;
    }
    const projects = (data as InfrastructureProjectRow[]) || [];
    for (const project of projects) {
      const match = project.project_url?.match(/https:\/\/(.+)\.supabase\.co/);
      if (!match || !project.management_pat) continue;
      const projectRef = match[1];
      try {
        const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${project.management_pat}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: 'SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS db_size FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = \'public\' AND c.relkind IN (\'r\', \'m\', \'p\')' }),
        });
        if (!res.ok) {
          console.warn(`[InfrastructureDB] Failed to get size for ${project.project_key}: ${res.status}`);
          continue;
        }
        const rows = await res.json() as { db_size: number }[];
        const usedBytes = rows?.[0]?.db_size ?? 0;
        await this.client!.from('infrastructure_projects')
          .update({ used_space: usedBytes, last_health_check: new Date().toISOString() })
          .eq('id', project.id);
        console.log(`[InfrastructureDB] ${project.project_key}: ${(usedBytes / 1e6).toFixed(1)} MB used`);
      } catch (err) {
        console.warn(`[InfrastructureDB] Error querying ${project.project_key}:`, (err as Error).message);
      }
    }
  }

  // ---- Storage Providers ----

  async getStorageAccounts(): Promise<StorageProviderRow[]> {
    if (this.fallback) return [...this.fallbackStorage];
    const { data, error } = await this.client!.from('storage_providers').select('*');
    if (error) throw new Error(`Failed to fetch storage accounts: ${error.message}`);
    return (data as StorageProviderRow[]) || [];
  }

  async getActiveStorageAccounts(): Promise<StorageProviderRow[]> {
    const accounts = await this.getStorageAccounts();
    return accounts.filter(a => a.status === 'active');
  }

  async getStorageAccountById(id: string): Promise<StorageProviderRow | null> {
    if (this.fallback) return this.fallbackStorage.find(a => a.id === id) || null;
    const { data, error } = await this.client!.from('storage_providers').select('*').eq('id', id).single();
    if (error && error.code !== 'PGRST116') throw new Error(`Failed to fetch storage account: ${error.message}`);
    return (data as StorageProviderRow) || null;
  }

  async registerStorageAccount(account: Omit<StorageProviderRow, 'id' | 'created_at' | 'updated_at'>): Promise<StorageProviderRow> {
    if (this.fallback) {
      const row: StorageProviderRow = {
        id: crypto.randomUUID(),
        ...account,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const existing = this.fallbackStorage.findIndex(a => a.provider_key === row.provider_key);
      if (existing >= 0) {
        this.fallbackStorage[existing] = row;
      } else {
        this.fallbackStorage.push(row);
      }
      this.fallbackStorage.sort((a, b) => a.priority - b.priority);
      return row;
    }
    const { data, error } = await this.client!.from('storage_providers').insert(account).select().single();
    if (error) throw new Error(`Failed to register storage account: ${error.message}`);
    return data as StorageProviderRow;
  }

  async updateStorageUsage(id: string, usedSpace: number): Promise<void> {
    if (this.fallback) {
      const account = this.fallbackStorage.find(a => a.id === id);
      if (account) account.used_space = usedSpace;
      return;
    }
    const { error } = await this.client!.from('storage_providers').update({ used_space: usedSpace }).eq('id', id);
    if (error) throw new Error(`Failed to update storage usage: ${error.message}`);
  }

  async updateStorageStatus(id: string, status: StorageStatus): Promise<void> {
    if (this.fallback) {
      const account = this.fallbackStorage.find(a => a.id === id);
      if (account) account.status = status;
      return;
    }
    const { error } = await this.client!.from('storage_providers').update({ status }).eq('id', id);
    if (error) throw new Error(`Failed to update storage status: ${error.message}`);
  }

  // ---- Domains (Routing) ----

  async getDomain(name: string): Promise<DomainRow | null> {
    if (this.fallback) return this.fallbackDomains.find(d => d.name === name) || null;
    const { data, error } = await this.client!.from('domains').select('*').eq('name', name).single();
    if (error && error.code !== 'PGRST116') throw new Error(`Failed to fetch domain: ${error.message}`);
    return (data as DomainRow) || null;
  }

  async getAllDomains(): Promise<DomainRow[]> {
    if (this.fallback) return [...this.fallbackDomains];
    const { data, error } = await this.client!.from('domains').select('*');
    if (error) throw new Error(`Failed to fetch domains: ${error.message}`);
    return (data as DomainRow[]) || [];
  }

  async getCurrentWriteProject(domain: string): Promise<InfrastructureProjectRow | null> {
    const domainRow = await this.getDomain(domain);
    if (!domainRow || !domainRow.current_write_project) return null;
    return this.getProjectById(domainRow.current_write_project);
  }

  async setCurrentWriteProject(domain: string, projectId: string): Promise<void> {
    if (this.fallback) {
      const domainRow = this.fallbackDomains.find(d => d.name === domain);
      if (domainRow) domainRow.current_write_project = projectId;
      return;
    }
    const { error } = await this.client!.from('domains').update({ current_write_project: projectId }).eq('name', domain);
    if (error) throw new Error(`Failed to set write project: ${error.message}`);
  }

  async registerDomain(domain: Omit<DomainRow, 'id' | 'created_at' | 'updated_at'>): Promise<DomainRow> {
    if (this.fallback) {
      const row: DomainRow = {
        id: crypto.randomUUID(),
        ...domain,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const existing = this.fallbackDomains.findIndex(d => d.name === row.name);
      if (existing >= 0) {
        this.fallbackDomains[existing] = row;
      } else {
        this.fallbackDomains.push(row);
      }
      return row;
    }
    const { data, error } = await this.client!.from('domains').insert(domain).select().single();
    if (error) throw new Error(`Failed to register domain: ${error.message}`);
    return data as DomainRow;
  }

  // ---- Gateway Settings ----

  async getSetting<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined> {
    if (this.fallback) {
      const setting = this.fallbackSettings.get(key);
      if (!setting) return defaultValue;
      const val = setting.value as Record<string, unknown>;
      return (val?.value as T) ?? defaultValue;
    }
    const { data, error } = await this.client!.from('gateway_settings').select('*').eq('key', key).single();
    if (error && error.code !== 'PGRST116') throw new Error(`Failed to fetch setting: ${error.message}`);
    if (!data) return defaultValue;
    const row = data as GatewaySettingRow;
    const val = row.value as Record<string, unknown>;
    return (val?.value as T) ?? defaultValue;
  }

  async getAllSettings(): Promise<GatewaySettingRow[]> {
    if (this.fallback) return [...this.fallbackSettings.values()];
    const { data, error } = await this.client!.from('gateway_settings').select('*');
    if (error) throw new Error(`Failed to fetch settings: ${error.message}`);
    return (data as GatewaySettingRow[]) || [];
  }

  async setSetting(key: string, value: unknown, type: SettingType = 'string'): Promise<void> {
    const setting = { key, value: { value }, type, updated_at: new Date().toISOString() };
    if (this.fallback) {
      const existing = this.fallbackSettings.get(key);
      if (existing) {
        existing.value = setting.value;
        existing.type = type;
        existing.updated_at = setting.updated_at;
      } else {
        this.fallbackSettings.set(key, {
          id: crypto.randomUUID(),
          key,
          value: setting.value,
          type,
          description: null,
          updated_at: setting.updated_at,
        });
      }
      this.notifySettingWatchers(key, value);
      return;
    }
    const { data: existing, error: fetchError } = await this.client!.from('gateway_settings').select('id').eq('key', key).single();
    if (fetchError && fetchError.code !== 'PGRST116') throw new Error(`Failed to check setting: ${fetchError.message}`);
    if (existing) {
      const { error } = await this.client!.from('gateway_settings').update(setting).eq('key', key);
      if (error) throw new Error(`Failed to update setting: ${error.message}`);
    } else {
      const { error } = await this.client!.from('gateway_settings').insert(setting);
      if (error) throw new Error(`Failed to create setting: ${error.message}`);
    }
    this.notifySettingWatchers(key, value);
  }

  private settingWatchers: Map<string, Set<(value: unknown) => void>> = new Map();

  watchSetting(key: string, callback: (value: unknown) => void): void {
    if (!this.settingWatchers.has(key)) {
      this.settingWatchers.set(key, new Set());
    }
    this.settingWatchers.get(key)!.add(callback);
  }

  private notifySettingWatchers(key: string, value: unknown): void {
    const watchers = this.settingWatchers.get(key);
    if (watchers) {
      for (const watcher of watchers) {
        watcher(value);
      }
    }
  }

  // ---- Health Logs ----

  async logHealth(entry: Omit<HealthLogRow, 'id' | 'checked_at'>): Promise<HealthLogRow> {
    if (this.fallback) {
      const row: HealthLogRow = {
        id: crypto.randomUUID(),
        ...entry,
        checked_at: new Date().toISOString(),
      };
      this.fallbackHealthLogs.push(row);
      if (this.fallbackHealthLogs.length > 10000) {
        this.fallbackHealthLogs.splice(0, this.fallbackHealthLogs.length - 10000);
      }
      return row;
    }
    const { data, error } = await this.client!.from('health_logs').insert(entry).select().single();
    if (error) throw new Error(`Failed to log health: ${error.message}`);
    return data as HealthLogRow;
  }

  async getHealthLogs(resourceType?: ResourceType, resourceId?: string, limit = 100): Promise<HealthLogRow[]> {
    if (this.fallback) {
      let logs = [...this.fallbackHealthLogs];
      if (resourceType) logs = logs.filter(l => l.resource_type === resourceType);
      if (resourceId) logs = logs.filter(l => l.resource_id === resourceId);
      return logs.slice(-limit).reverse();
    }
    let query = this.client!.from('health_logs').select('*').order('checked_at', { ascending: false }).limit(limit);
    if (resourceType) query = query.eq('resource_type', resourceType);
    if (resourceId) query = query.eq('resource_id', resourceId);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to fetch health logs: ${error.message}`);
    return (data as HealthLogRow[]) || [];
  }

  // ---- Initialization Helpers ----

  private initFallback(): void {
    this.fallbackProviders = [
      { id: crypto.randomUUID(), name: 'Supabase', type: 'database', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), name: 'PostgreSQL', type: 'database', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), name: 'MongoDB', type: 'database', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), name: 'Cloudinary', type: 'storage', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), name: 'AWS S3', type: 'storage', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), name: 'Cloudflare R2', type: 'storage', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ];

    const supabaseId = this.fallbackProviders[0].id;

    this.fallbackProjects = [
      { id: crypto.randomUUID(), project_key: 'posts_1', domain: 'posts', provider_id: supabaseId, project_url: '', service_key: '', anon_key: '', status: 'active', capacity: 500000000, used_space: 500000000, priority: 1, load_weight: 50, write_enabled: true, health_status: 'online', region: null, response_time: null, last_health_check: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), project_key: 'posts_2', domain: 'posts', provider_id: supabaseId, project_url: '', service_key: '', anon_key: '', status: 'active', capacity: 500000000, used_space: 100000000, priority: 2, load_weight: 30, write_enabled: true, health_status: 'online', region: null, response_time: null, last_health_check: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), project_key: 'posts_3', domain: 'posts', provider_id: supabaseId, project_url: '', service_key: '', anon_key: '', status: 'active', capacity: 500000000, used_space: 10000000, priority: 3, load_weight: 20, write_enabled: true, health_status: 'online', region: null, response_time: null, last_health_check: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), project_key: 'comments_1', domain: 'comments', provider_id: supabaseId, project_url: '', service_key: '', anon_key: '', status: 'active', capacity: 500000000, used_space: 200000000, priority: 1, load_weight: 50, write_enabled: true, health_status: 'online', region: null, response_time: null, last_health_check: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), project_key: 'comments_2', domain: 'comments', provider_id: supabaseId, project_url: '', service_key: '', anon_key: '', status: 'active', capacity: 500000000, used_space: 50000000, priority: 2, load_weight: 30, write_enabled: true, health_status: 'online', region: null, response_time: null, last_health_check: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), project_key: 'comments_3', domain: 'comments', provider_id: supabaseId, project_url: '', service_key: '', anon_key: '', status: 'active', capacity: 500000000, used_space: 10000000, priority: 3, load_weight: 20, write_enabled: true, health_status: 'online', region: null, response_time: null, last_health_check: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), project_key: 'stories_1', domain: 'stories', provider_id: supabaseId, project_url: '', service_key: '', anon_key: '', status: 'active', capacity: 500000000, used_space: 150000000, priority: 1, load_weight: 100, write_enabled: true, health_status: 'online', region: null, response_time: null, last_health_check: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), project_key: 'profiles_1', domain: 'profiles', provider_id: supabaseId, project_url: '', service_key: '', anon_key: '', status: 'active', capacity: 500000000, used_space: 50000000, priority: 1, load_weight: 100, write_enabled: true, health_status: 'online', region: null, response_time: null, last_health_check: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ];
    this.fallbackProjects.sort((a, b) => a.priority - b.priority);

    const cloudinaryId = this.fallbackProviders[3].id;
    const s3Id = this.fallbackProviders[4].id;

    this.fallbackStorage = [
      { id: crypto.randomUUID(), provider_key: 'cloudinary_1', provider_id: cloudinaryId, cloud_name: '', api_key: '', api_secret: '', status: 'active', capacity: 10000000000, used_space: 9500000000, priority: 1, region: null, response_time: null, last_health_check: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), provider_key: 'cloudinary_2', provider_id: cloudinaryId, cloud_name: '', api_key: '', api_secret: '', status: 'active', capacity: 10000000000, used_space: 1000000000, priority: 2, region: null, response_time: null, last_health_check: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: crypto.randomUUID(), provider_key: 's3_main', provider_id: s3Id, cloud_name: '', api_key: '', api_secret: '', status: 'active', capacity: 50000000000, used_space: 5000000000, priority: 3, region: null, response_time: null, last_health_check: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ];
    this.fallbackStorage.sort((a, b) => a.priority - b.priority);

    const defaults: Array<{ key: string; value: unknown; type: SettingType }> = [
      { key: 'writeThreshold', value: 90, type: 'number' },
      { key: 'retryCount', value: 3, type: 'number' },
      { key: 'maxUploadSize', value: 10485760, type: 'number' },
      { key: 'healthCheckInterval', value: 60, type: 'number' },
      { key: 'softDeleteRetentionDays', value: 30, type: 'number' },
      { key: 'aiModerationEnabled', value: true, type: 'boolean' },
    ];
    for (const d of defaults) {
      this.fallbackSettings.set(d.key, {
        id: crypto.randomUUID(),
        key: d.key,
        value: { value: d.value },
        type: d.type,
        description: null,
        updated_at: new Date().toISOString(),
      });
    }
  }
}

export const infrastructureDb = new InfrastructureDatabase();
