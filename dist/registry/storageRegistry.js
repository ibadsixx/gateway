"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storageRegistry = void 0;
const infrastructureDb_1 = require("../infrastructure/database/infrastructureDb");
function toLegacyStatus(dbStatus) {
    switch (dbStatus) {
        case 'active': return 'ACTIVE';
        case 'disabled': return 'DISABLED';
        case 'maintenance': return 'MAINTENANCE';
        default: return 'DISABLED';
    }
}
function toDbStatus(status) {
    switch (status) {
        case 'ACTIVE': return 'active';
        case 'DISABLED': return 'disabled';
        case 'MAINTENANCE': return 'maintenance';
    }
}
function toLegacyAccount(row) {
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
    async register(account) {
        const dbProviders = await infrastructureDb_1.infrastructureDb.getProviders();
        const providerRow = dbProviders.find(p => p.name.toLowerCase() === account.provider.toLowerCase())
            || dbProviders.find(p => p.type === 'storage');
        await infrastructureDb_1.infrastructureDb.registerStorageAccount({
            provider_key: (account.id || account.provider_key || `${account.provider}_${Date.now()}`),
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
    async getActiveAccounts() {
        const rows = await infrastructureDb_1.infrastructureDb.getActiveStorageAccounts();
        return rows.map(toLegacyAccount);
    }
    async getActiveAccount() {
        const active = await infrastructureDb_1.infrastructureDb.getActiveStorageAccounts();
        if (active.length === 0)
            return undefined;
        const candidates = active.filter(a => a.used_space / a.capacity < 0.9);
        const pool = candidates.length > 0 ? candidates : active;
        const best = pool.reduce((a, b) => (a.used_space / a.capacity) < (b.used_space / b.capacity) ? a : b);
        return toLegacyAccount(best);
    }
    async updateUsage(id, usedSpace) {
        await infrastructureDb_1.infrastructureDb.updateStorageUsage(id, usedSpace);
    }
    async updateStatus(id, status) {
        await infrastructureDb_1.infrastructureDb.updateStorageStatus(id, toDbStatus(status));
    }
    async getAllAccounts() {
        const rows = await infrastructureDb_1.infrastructureDb.getStorageAccounts();
        return rows.map(toLegacyAccount);
    }
}
exports.storageRegistry = new StorageRegistry();
//# sourceMappingURL=storageRegistry.js.map