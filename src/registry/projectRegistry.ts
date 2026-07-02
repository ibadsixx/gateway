import { databaseRegistry, DatabaseProject } from './databaseRegistry';
import { storageRegistry, StorageAccount } from './storageRegistry';

class ProjectRegistry {
  async findDatabaseProject(domain: string): Promise<DatabaseProject | undefined> {
    return await databaseRegistry.getActiveProject(domain);
  }

  async findStorageAccount(): Promise<StorageAccount | undefined> {
    return await storageRegistry.getActiveAccount();
  }

  async updateDatabaseStatus(id: string, status: DatabaseProject['status']): Promise<void> {
    await databaseRegistry.updateStatus(id, status);
  }

  async updateStorageUsage(id: string, usedSpace: number): Promise<void> {
    await storageRegistry.updateUsage(id, usedSpace);
  }

  async getInfrastructureStatus() {
    const databases = await databaseRegistry.getAllProjects();
    const storage = await storageRegistry.getAllAccounts();
    return { databases, storage };
  }
}

export const projectRegistry = new ProjectRegistry();
