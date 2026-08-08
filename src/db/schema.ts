export type ProviderType = 'database' | 'storage' | 'ai' | 'search';
export type ProviderStatus = 'active' | 'inactive' | 'disabled';
export type ProjectStatus = 'active' | 'read_only' | 'disabled' | 'maintenance';
export type StorageStatus = 'active' | 'disabled' | 'maintenance';
export type StorageAccountStatus = 'available' | 'full';
export type HealthStatus = 'online' | 'degraded' | 'offline';
export type ResourceType = 'database' | 'storage' | 'service';
export type SettingType = 'string' | 'number' | 'boolean' | 'json';

export interface ProviderRow {
  id: string;
  name: string;
  type: ProviderType;
  status: ProviderStatus;
  created_at: string;
  updated_at: string;
}

export interface InfrastructureProjectRow {
  id: string;
  project_key: string;
  domain: string;
  provider_id: string;
  project_url: string;
  service_key: string;
  anon_key: string;
  status: ProjectStatus;
  capacity: number;
  used_space: number;
  priority: number;
  load_weight: number;
  write_enabled?: boolean;
  health_status?: HealthStatus;
  management_pat?: string;
  region: string | null;
  response_time: number | null;
  last_health_check: string | null;
  created_at: string;
  updated_at: string;
}

export interface InfrastructureStorageRow {
  id: string;
  storage_key: string;
  provider_id: string;
  cloud_name: string;
  api_key: string;
  api_secret: string;
  status: StorageAccountStatus;
  capacity: number;
  used_space: number;
  available_space: number;
  last_update: string;
  created_at: string;
  updated_at: string;
}

export interface DomainRow {
  id: string;
  name: string;
  current_write_project: string | null;
  next_project: string | null;
  created_at: string;
  updated_at: string;
}

export interface GatewaySettingRow {
  id: string;
  key: string;
  value: unknown;
  type: SettingType;
  description: string | null;
  updated_at: string;
}

export interface HealthLogRow {
  id: string;
  resource_type: ResourceType;
  resource_id: string;
  status: HealthStatus;
  latency_ms: number;
  usage_pct: number;
  error_message: string | null;
  checked_at: string;
}
