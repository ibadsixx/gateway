import { databaseRegistry } from '../../registry/databaseRegistry';
import { storageRegistry } from '../../registry/storageRegistry';
import { infrastructureDb } from '../database/infrastructureDb';
import { configCenter } from '../../config';

class MonitoringService {
  private interval?: NodeJS.Timeout;

  start(intervalMs: number = 60000): void {
    console.log(`Monitoring started (interval: ${intervalMs}ms)`);
    this.interval = setInterval(() => this.check(), intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private async check(): Promise<void> {
    const writeThreshold = configCenter.get<number>('writeThreshold', 90);

    const databases = await databaseRegistry.getAllProjects();
    for (const db of databases) {
      const responseTime = Math.random() * 200;
      const usagePct = (db.usedSpace / Math.max(db.capacity, 1)) * 100;

      await databaseRegistry.updateHealth(db.id, responseTime, db.usedSpace);

      const healthStatus = usagePct > 95 ? 'degraded' as const
        : usagePct > 99 ? 'offline' as const
        : 'online' as const;

      await infrastructureDb.logHealth({
        resource_type: 'database',
        resource_id: db.id,
        status: healthStatus,
        latency_ms: responseTime,
        usage_pct: usagePct,
        error_message: healthStatus !== 'online' ? `Usage at ${usagePct.toFixed(1)}%` : null,
      });

      if (usagePct > writeThreshold) {
        console.warn(`Database ${db.id} is at ${usagePct.toFixed(1)}% capacity`);
        await databaseRegistry.updateStatus(db.id, 'READ_ONLY');
      }
    }

    const accounts = await storageRegistry.getAllAccounts();
    for (const account of accounts) {
      const usagePct = (account.usedSpace / Math.max(account.capacity, 1)) * 100;

      const healthStatus = usagePct > 95 ? 'degraded' as const
        : usagePct > 99 ? 'offline' as const
        : 'online' as const;

      await infrastructureDb.logHealth({
        resource_type: 'storage',
        resource_id: account.id,
        status: healthStatus,
        latency_ms: 0,
        usage_pct: usagePct,
        error_message: healthStatus !== 'online' ? `Usage at ${usagePct.toFixed(1)}%` : null,
      });

      if (usagePct > writeThreshold) {
        console.warn(`Storage ${account.id} is at ${usagePct.toFixed(1)}% capacity`);
      }
    }

    console.log(`Checked ${databases.length} databases, ${accounts.length} storage accounts`);
  }
}

export const monitoring = new MonitoringService();
