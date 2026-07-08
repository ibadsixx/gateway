"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.routingService = void 0;
const project_manager_1 = require("../project-manager");
const bus_1 = require("../events/bus");
const metrics_1 = require("../metrics");
const engine_1 = require("../retry/engine");
class RoutingService {
    write(domain, data) {
        const start = Date.now();
        const entry = project_manager_1.projectManager.getWritableProject(domain);
        if (!entry) {
            return Promise.reject(new Error(`No writable project for domain: ${domain}`));
        }
        const { client } = entry;
        return engine_1.RetryEngine.execute(async () => {
            const { data: inserted, error } = await client.from(domain).insert(data).select().single();
            if (error)
                return Promise.reject(new Error(`Insert error: ${error.message}`));
            const result = inserted;
            bus_1.eventBus.emit({
                type: `${domain}.created`,
                payload: { id: result.id, data },
                metadata: { timestamp: new Date(), source: 'routing-service' },
            });
            metrics_1.metricsService.record('db.write.duration', Date.now() - start, { domain });
            return result;
        });
    }
    read(domain, id) {
        const start = Date.now();
        const entry = project_manager_1.projectManager.getReadClient(domain, id);
        const { client } = entry;
        return engine_1.RetryEngine.execute(async () => {
            const { data, error } = await client.from(domain).select('*').eq('id', id).single();
            if (error) {
                if (error.code === 'PGRST116')
                    return null;
                return Promise.reject(new Error(`Read error: ${error.message}`));
            }
            metrics_1.metricsService.record('db.read.duration', Date.now() - start, { domain });
            return data;
        });
    }
    update(domain, id, data) {
        const start = Date.now();
        const entry = project_manager_1.projectManager.getReadClient(domain, id);
        const { client } = entry;
        return engine_1.RetryEngine.execute(async () => {
            const { data: updated, error } = await client.from(domain).update(data).eq('id', id).select().single();
            if (error)
                return Promise.reject(new Error(`Update error: ${error.message}`));
            bus_1.eventBus.emit({
                type: `${domain}.updated`,
                payload: { id, data },
                metadata: { timestamp: new Date(), source: 'routing-service' },
            });
            metrics_1.metricsService.record('db.update.duration', Date.now() - start, { domain });
            return updated;
        });
    }
    delete(domain, id, permanent = false) {
        const start = Date.now();
        const doDelete = () => {
            const entry = project_manager_1.projectManager.getReadClient(domain, id);
            const { client } = entry;
            return engine_1.RetryEngine.execute(async () => {
                if (permanent) {
                    const { error } = await client.from(domain).delete().eq('id', id);
                    if (error)
                        return Promise.reject(new Error(`Delete error: ${error.message}`));
                }
                else {
                    const { error } = await client.from(domain).update({ deletedAt: new Date() }).eq('id', id);
                    if (error)
                        return Promise.reject(new Error(`Soft delete error: ${error.message}`));
                }
                bus_1.eventBus.emit({
                    type: `${domain}.deleted`,
                    payload: { id, permanent },
                    metadata: { timestamp: new Date(), source: 'routing-service' },
                });
                metrics_1.metricsService.record('db.delete.duration', Date.now() - start, { domain });
            });
        };
        return doDelete();
    }
    query(domain, filter) {
        const entry = project_manager_1.projectManager.getWritableProject(domain);
        if (!entry) {
            return Promise.reject(new Error(`No writable project for domain: ${domain}`));
        }
        const { client } = entry;
        return engine_1.RetryEngine.execute(async () => {
            let query = client.from(domain).select('*');
            for (const [key, value] of Object.entries(filter)) {
                if (value === null) {
                    query = query.is(key, null);
                }
                else {
                    query = query.eq(key, value);
                }
            }
            const { data, error } = await query;
            if (error)
                return Promise.reject(new Error(`Query error: ${error.message}`));
            return data || [];
        });
    }
}
exports.routingService = new RoutingService();
//# sourceMappingURL=service.js.map