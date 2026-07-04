"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.database = void 0;
const service_1 = require("../../routing/service");
const databaseRegistry_1 = require("../../registry/databaseRegistry");
const database_1 = require("../../providers/database");
const types_1 = require("../../providers/database/types");
const bus_1 = require("../../events/bus");
const metrics_1 = require("../../metrics");
const engine_1 = require("../../retry/engine");
const crypto_1 = require("crypto");
function getConfig(project) {
    return (0, types_1.connectionConfigFromProject)(project);
}
class DatabaseLayer {
    async read(domain, id) {
        const start = Date.now();
        try {
            const activeProjects = await databaseRegistry_1.databaseRegistry.getActiveProjects(domain);
            if (activeProjects.length === 0) {
                throw new Error(`No active projects for domain: ${domain}`);
            }
            const project = this.routeByHash(activeProjects, id);
            const config = getConfig(project);
            const provider = (0, database_1.getDatabaseProvider)(project.provider || 'supabase');
            const result = await engine_1.RetryEngine.execute(() => provider.find(domain, id, config));
            metrics_1.metricsService.record('db.read.duration', Date.now() - start, { domain });
            return result;
        }
        catch (error) {
            metrics_1.metricsService.increment('db.read.errors', { domain });
            throw error;
        }
    }
    async write(domain, data) {
        const start = Date.now();
        try {
            const project = await service_1.routingService.getWritableProject(domain);
            const config = getConfig(project);
            const provider = (0, database_1.getDatabaseProvider)(project.provider || 'supabase');
            const result = await engine_1.RetryEngine.execute(() => provider.create(domain, data, config));
            bus_1.eventBus.emit({
                type: `${domain}.created`,
                payload: { id: result.id, data },
                metadata: { timestamp: new Date(), source: 'database-layer' },
            });
            metrics_1.metricsService.record('db.write.duration', Date.now() - start, { domain });
            return result;
        }
        catch (error) {
            metrics_1.metricsService.increment('db.write.errors', { domain });
            throw error;
        }
    }
    async update(domain, id, data) {
        const start = Date.now();
        try {
            const activeProjects = await databaseRegistry_1.databaseRegistry.getActiveProjects(domain);
            if (activeProjects.length === 0) {
                throw new Error(`No active projects for domain: ${domain}`);
            }
            const project = this.routeByHash(activeProjects, id);
            const config = getConfig(project);
            const provider = (0, database_1.getDatabaseProvider)(project.provider || 'supabase');
            const result = await engine_1.RetryEngine.execute(() => provider.update(domain, id, data, config));
            bus_1.eventBus.emit({
                type: `${domain}.updated`,
                payload: { id, data },
                metadata: { timestamp: new Date(), source: 'database-layer' },
            });
            metrics_1.metricsService.record('db.update.duration', Date.now() - start, { domain });
            return result;
        }
        catch (error) {
            metrics_1.metricsService.increment('db.update.errors', { domain });
            throw error;
        }
    }
    async delete(domain, id, permanent = false) {
        const start = Date.now();
        try {
            if (permanent) {
                const activeProjects = await databaseRegistry_1.databaseRegistry.getActiveProjects(domain);
                if (activeProjects.length === 0) {
                    throw new Error(`No active projects for domain: ${domain}`);
                }
                const project = this.routeByHash(activeProjects, id);
                const config = getConfig(project);
                const provider = (0, database_1.getDatabaseProvider)(project.provider || 'supabase');
                await engine_1.RetryEngine.execute(() => provider.delete(domain, id, config));
            }
            else {
                await this.update(domain, id, { deletedAt: new Date() });
            }
            bus_1.eventBus.emit({
                type: `${domain}.deleted`,
                payload: { id, permanent },
                metadata: { timestamp: new Date(), source: 'database-layer' },
            });
            metrics_1.metricsService.record('db.delete.duration', Date.now() - start, { domain });
        }
        catch (error) {
            metrics_1.metricsService.increment('db.delete.errors', { domain });
            throw error;
        }
    }
    async query(domain, filter) {
        const project = await service_1.routingService.getWritableProject(domain);
        const config = getConfig(project);
        const provider = (0, database_1.getDatabaseProvider)(project.provider || 'supabase');
        const results = await provider.query(domain, { ...filter, deletedAt: null }, config);
        return results;
    }
    routeByHash(projects, entityId) {
        if (projects.length === 1)
            return projects[0];
        const hash = (0, crypto_1.createHash)('md5').update(entityId).digest('hex');
        const hashNum = parseInt(hash.substring(0, 8), 16);
        return projects[hashNum % projects.length];
    }
}
exports.database = new DatabaseLayer();
//# sourceMappingURL=index.js.map