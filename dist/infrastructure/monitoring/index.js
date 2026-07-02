"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.monitoring = void 0;
const databaseRegistry_1 = require("../../registry/databaseRegistry");
const storageRegistry_1 = require("../../registry/storageRegistry");
const infrastructureDb_1 = require("../database/infrastructureDb");
const config_1 = require("../../config");
class MonitoringService {
    interval;
    start(intervalMs = 60000) {
        console.log(`Monitoring started (interval: ${intervalMs}ms)`);
        this.interval = setInterval(() => this.check(), intervalMs);
    }
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
    }
    async check() {
        const writeThreshold = config_1.configCenter.get('writeThreshold', 90);
        const databases = await databaseRegistry_1.databaseRegistry.getAllProjects();
        for (const db of databases) {
            const responseTime = Math.random() * 200;
            const usagePct = (db.usedSpace / Math.max(db.capacity, 1)) * 100;
            await databaseRegistry_1.databaseRegistry.updateHealth(db.id, responseTime, db.usedSpace);
            const healthStatus = usagePct > 95 ? 'degraded'
                : usagePct > 99 ? 'offline'
                    : 'online';
            await infrastructureDb_1.infrastructureDb.logHealth({
                resource_type: 'database',
                resource_id: db.id,
                status: healthStatus,
                latency_ms: responseTime,
                usage_pct: usagePct,
                error_message: healthStatus !== 'online' ? `Usage at ${usagePct.toFixed(1)}%` : null,
            });
            if (usagePct > writeThreshold) {
                console.warn(`Database ${db.id} is at ${usagePct.toFixed(1)}% capacity`);
                await databaseRegistry_1.databaseRegistry.updateStatus(db.id, 'READ_ONLY');
            }
        }
        const accounts = await storageRegistry_1.storageRegistry.getAllAccounts();
        for (const account of accounts) {
            const usagePct = (account.usedSpace / Math.max(account.capacity, 1)) * 100;
            const healthStatus = usagePct > 95 ? 'degraded'
                : usagePct > 99 ? 'offline'
                    : 'online';
            await infrastructureDb_1.infrastructureDb.logHealth({
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
exports.monitoring = new MonitoringService();
//# sourceMappingURL=index.js.map