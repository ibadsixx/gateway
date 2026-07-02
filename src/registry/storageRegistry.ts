import { infrastructureDb } from '../infrastructure/database/infrastructureDb';
import type { StorageProviderRow, StorageStatus } from '../db/schema';

export interface StorageAccount {
  id: string;
  provider: string;
  status: 'ACTIVE' | 'DISABLED' | 'MAINTENANCE';
  capacity: number;
  usedSpace: number;
  priority: number;
  region?: string;
  responseTime?: number;
}

function toLegacyStatus(dbStatus: string): StorageAccount['status'] {
  switch (dbStatus) {
    case 'active': return 'ACTIVE';
    case 'disabled': return 'DISABLED';
    case 'maintenance': return 'MAINTENANCE';
    default: return 'DISABLED';
  }
}

function toDbStatus(status: StorageAccount['status']): StorageStatus {
  switch (status) {
    case 'ACTIVE': return 'active';
    case 'DISABLED': return 'disabled';
    case 'MAINTENANCE': return 'maintenance';
  }
}

function toLegacyAccount(row: StorageProviderRow): StorageAccount {
  return {
    id: row.id,
    provider: '',
    status: toLegacyStatus(row.status),
    capacity: row.capacity,
    usedSpace: row.used_space,
    priority: row.priority,
    region: row.region || undefined,
    responseTime: row.response_time ?? undefined,
  };
}

class StorageRegistry {
  async register(account: {
    id?: string;
    provider_key?: string;
    provider: string;
    status: StorageAccount['status'];
    capacity: number;
    usedSpace: number;
    priority: number;
  }): Promise<void> {
    const dbProviders = await infrastructureDb.getProviders();
    const providerRow = dbProviders.find(p => p.name.toLowerCase() === account.provider.toLowerCase())
      || dbProviders.find(p => p.type === 'storage');

    await infrastructureDb.registerStorageAccount({
      provider_key: (account.id || account.provider_key || `${account.provider}_${Date.now()}`) as string,
      provider_id: providerRow?.id || crypto.randomUUID(),
      cloud_name: '',
      api_key: '',
      api_secret: '',
      status: toDbStatus(account.status),
      capacity: account.capacity,
      used_space: account.usedSpace,
      priority: account.priority,
      region: null,
      response_time: null,
      last_health_check: null,
    });
  }

  async getActiveAccounts(): Promise<StorageAccount[]> {
    const rows = await infrastructureDb.getActiveStorageAccounts();
    return rows.map(toLegacyAccount);
  }

  async getActiveAccount(): Promise<StorageAccount | undefined> {
    const active = await infrastructureDb.getActiveStorageAccounts();
    if (active.length === 0) return undefined;

    const candidates = active.filter(a => a.used_space / a.capacity < 0.9);
    const pool = candidates.length > 0 ? candidates : active;
    const best = pool.reduce((a, b) =>
      (a.used_space / a.capacity) < (b.used_space / b.capacity) ? a : b,
    );
    return toLegacyAccount(best);
  }

  async updateUsage(id: string, usedSpace: number): Promise<void> {
    await infrastructureDb.updateStorageUsage(id, usedSpace);
  }

  async updateStatus(id: string, status: StorageAccount['status']): Promise<void> {
    await infrastructureDb.updateStorageStatus(id, toDbStatus(status));
  }

  async getAllAccounts(): Promise<StorageAccount[]> {
    const rows = await infrastructureDb.getStorageAccounts();
    return rows.map(toLegacyAccount);
  }
}

export const storageRegistry = new StorageRegistry();
