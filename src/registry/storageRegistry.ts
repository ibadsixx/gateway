import { infrastructureDb } from '../infrastructure/database/infrastructureDb';
import type { InfrastructureStorageRow, StorageAccountStatus } from '../db/schema';

export interface StorageAccount {
  id: string;
  provider: string;
  status: StorageAccountStatus;
  capacity: number;
  usedSpace: number;
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class StorageRegistry {
  private providerNames: Map<string, string> = new Map();

  private async loadProviderNames(): Promise<void> {
    try {
      const providers = await infrastructureDb.getProviders();
      this.providerNames = new Map(providers.map(p => [p.id, p.name.toLowerCase()]));
    } catch {
      this.providerNames = new Map();
    }
  }

  private async toAccount(row: InfrastructureStorageRow): Promise<StorageAccount> {
    if (this.providerNames.size === 0) await this.loadProviderNames();
    return {
      id: row.id,
      provider: this.providerNames.get(row.provider_id) || 'cloudinary',
      status: row.status,
      capacity: row.capacity,
      usedSpace: row.used_space,
      cloudName: row.cloud_name,
      apiKey: row.api_key,
      apiSecret: row.api_secret,
    };
  }

  async register(account: {
    storageKey?: string;
    provider: string;
    status: StorageAccountStatus;
    capacity: number;
    usedSpace: number;
    cloudName?: string;
    apiKey?: string;
    apiSecret?: string;
  }): Promise<void> {
    const dbProviders = await infrastructureDb.getProviders();
    const providerRow = dbProviders.find(p => p.name.toLowerCase() === account.provider.toLowerCase())
      || dbProviders.find(p => p.type === 'storage');

    await infrastructureDb.registerStorageAccount({
      storage_key: (account.storageKey || `${account.provider}_${Date.now()}`) as string,
      provider_id: providerRow?.id || crypto.randomUUID(),
      cloud_name: account.cloudName || '',
      api_key: account.apiKey || '',
      api_secret: account.apiSecret || '',
      status: account.status,
      capacity: account.capacity,
      used_space: account.usedSpace,
    });
  }

  async getActiveAccounts(): Promise<StorageAccount[]> {
    const rows = await infrastructureDb.getActiveStorageAccounts();
    return Promise.all(rows.map(row => this.toAccount(row)));
  }

  async getActiveAccount(): Promise<StorageAccount | undefined> {
    const active = await this.getActiveAccounts();
    if (active.length === 0) return undefined;
    return shuffle(active)[0];
  }

  async markFull(id: string): Promise<void> {
    await infrastructureDb.updateStorageStatus(id, 'full');
  }

  async markAvailable(id: string): Promise<void> {
    await infrastructureDb.updateStorageStatus(id, 'available');
  }

  async updateUsage(id: string, usedSpace: number): Promise<void> {
    await infrastructureDb.updateStorageUsage(id, usedSpace);
  }

  async getAllAccounts(): Promise<Array<Omit<StorageAccount, 'apiKey' | 'apiSecret'>>> {
    const rows = await infrastructureDb.getStorageAccounts();
    const accounts = await Promise.all(rows.map(row => this.toAccount(row)));
    return accounts.map(({ apiKey: _apiKey, apiSecret: _apiSecret, ...rest }) => rest);
  }
}

export const storageRegistry = new StorageRegistry();
