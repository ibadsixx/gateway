"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const databaseRegistry_1 = require("../registry/databaseRegistry");
const circuit_breaker_1 = require("../circuit-breaker");
const engine_1 = require("../retry/engine");
const crypto_1 = require("crypto");
class Router {
    circuitBreakers = new Map();
    async route(domain, entityId) {
        if (entityId) {
            return this.routeRead(domain, entityId);
        }
        return this.routeWrite(domain);
    }
    async routeRead(domain, entityId) {
        const activeProjects = await databaseRegistry_1.databaseRegistry.getActiveProjects(domain);
        if (activeProjects.length === 0) {
            throw new Error(`No active projects available for domain: ${domain}`);
        }
        if (activeProjects.length === 1) {
            return activeProjects[0].id;
        }
        const selected = this.selectByHash(entityId, activeProjects);
        return this.getProjectConnection(domain, selected);
    }
    async routeWrite(domain) {
        const project = await databaseRegistry_1.databaseRegistry.getWritableProject(domain);
        if (!project) {
            throw new Error(`No writable project found for domain: ${domain}`);
        }
        return project.id;
    }
    selectByHash(entityId, projects) {
        const hash = (0, crypto_1.createHash)('md5').update(entityId).digest('hex');
        const hashNum = parseInt(hash.substring(0, 8), 16);
        const index = hashNum % projects.length;
        return projects[index];
    }
    async getProjectConnection(domain, project) {
        const cb = this.getOrCreateCircuitBreaker(project.id);
        return engine_1.RetryEngine.execute(async () => {
            return cb.call(async () => {
                await databaseRegistry_1.databaseRegistry.updateHealth(project.id, Math.random() * 100, project.usedSpace);
                return project.id;
            });
        }, {
            maxRetries: 2,
            onRetry: async (_attempt, _error) => {
                const active = await databaseRegistry_1.databaseRegistry.getActiveProjects(domain);
                const next = active.find(p => p.id !== project.id);
                if (next) {
                    project.id = next.id;
                }
            },
        });
    }
    getOrCreateCircuitBreaker(projectId) {
        if (!this.circuitBreakers.has(projectId)) {
            this.circuitBreakers.set(projectId, new circuit_breaker_1.CircuitBreaker({
                failureThreshold: 5,
                successThreshold: 2,
                timeout: 30000,
            }));
        }
        return this.circuitBreakers.get(projectId);
    }
}
exports.router = new Router();
//# sourceMappingURL=router.js.map