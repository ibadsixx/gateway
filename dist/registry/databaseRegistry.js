"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseRegistry = void 0;
const infrastructureDb_1 = require("../infrastructure/database/infrastructureDb");
function toLegacyStatus(dbStatus) {
    switch (dbStatus) {
        case 'active': return 'ACTIVE';
        case 'read_only': return 'READ_ONLY';
        case 'disabled': return 'DISABLED';
        case 'maintenance': return 'MAINTENANCE';
        default: return 'DISABLED';
    }
}
function toDbStatus(status) {
    switch (status) {
        case 'ACTIVE': return 'active';
        case 'READ_ONLY': return 'read_only';
        case 'DISABLED': return 'disabled';
        case 'MAINTENANCE': return 'maintenance';
    }
}
function toLegacyProject(row) {
    return {
        id: row.id,
        domain: row.domain,
        provider: '',
        status: toLegacyStatus(row.status),
        priority: row.priority,
        capacity: row.capacity,
        usedSpace: row.used_space,
        connectionName: row.project_url,
        projectUrl: row.project_url || undefined,
        serviceKey: row.service_key || undefined,
        anonKey: row.anon_key || undefined,
        region: row.region || undefined,
        responseTime: row.response_time ?? undefined,
        loadWeight: row.load_weight,
        lastHealthCheck: row.last_health_check ? new Date(row.last_health_check) : undefined,
    };
}
class DatabaseRegistry {
    cache = new Map();
    cacheTimestamp = 0;
    cacheTtl = 5000;
    async getCached(domain) {
        if (Date.now() - this.cacheTimestamp > this.cacheTtl) {
            this.cache.clear();
        }
        const key = `domain:${domain}`;
        if (!this.cache.has(key)) {
            const rows = await infrastructureDb_1.infrastructureDb.getProjects(domain);
            this.cache.set(key, rows.map(toLegacyProject));
            this.cacheTimestamp = Date.now();
        }
        return this.cache.get(key) || [];
    }
    invalidateCache() {
        this.cache.clear();
    }
    async register(project) {
        const dbProviders = await infrastructureDb_1.infrastructureDb.getProviders();
        const providerRow = dbProviders.find(p => p.name.toLowerCase() === project.provider.toLowerCase())
            || dbProviders.find(p => p.type === 'database');
        await infrastructureDb_1.infrastructureDb.registerProject({
            project_key: (project.id || project.project_key || `${project.domain}_${Date.now()}`),
            domain: project.domain,
            provider_id: providerRow?.id || crypto.randomUUID(),
            project_url: project.projectUrl || project.connectionName || '',
            service_key: project.serviceKey || '',
            anon_key: project.anonKey || '',
            status: toDbStatus(project.status),
            capacity: project.capacity,
            used_space: project.usedSpace,
            priority: project.priority,
            load_weight: project.loadWeight ?? 100,
            region: null,
            response_time: null,
            last_health_check: null,
        });
        const domain = await infrastructureDb_1.infrastructureDb.getDomain(project.domain);
        const dbProjects = await infrastructureDb_1.infrastructureDb.getProjects(project.domain);
        const activeProjects = dbProjects.filter(p => p.status === 'active');
        const firstActive = activeProjects.length > 0
            ? activeProjects.reduce((a, b) => a.priority <= b.priority ? a : b)
            : null;
        if (!domain) {
            await infrastructureDb_1.infrastructureDb.registerDomain({
                name: project.domain,
                current_write_project: firstActive?.id || null,
                next_project: null,
            });
        }
        else if (!domain.current_write_project && firstActive) {
            await infrastructureDb_1.infrastructureDb.setCurrentWriteProject(project.domain, firstActive.id);
        }
        this.invalidateCache();
    }
    async getActiveProjects(domain) {
        const rows = await infrastructureDb_1.infrastructureDb.getActiveProjects(domain);
        return rows.map(toLegacyProject);
    }
    async getActiveProject(domain) {
        const active = await this.getActiveProjects(domain);
        if (active.length === 0)
            return undefined;
        if (active.length === 1)
            return active[0];
        const writeTarget = await infrastructureDb_1.infrastructureDb.getCurrentWriteProject(domain);
        if (writeTarget) {
            const match = active.find(p => p.id === writeTarget.id);
            if (match)
                return match;
        }
        return this.selectByLoad(active);
    }
    async getProjectById(id) {
        const row = await infrastructureDb_1.infrastructureDb.getProjectById(id);
        return row ? toLegacyProject(row) : undefined;
    }
    async updateStatus(id, status) {
        await infrastructureDb_1.infrastructureDb.updateProjectStatus(id, toDbStatus(status));
        this.invalidateCache();
    }
    async updateHealth(id, responseTime, usedSpace) {
        await infrastructureDb_1.infrastructureDb.updateProjectHealth(id, responseTime, usedSpace);
    }
    async getAllProjects() {
        const rows = await infrastructureDb_1.infrastructureDb.getProjects();
        return rows.map(toLegacyProject);
    }
    async getProjectsByDomain(domain) {
        return this.getCached(domain);
    }
    selectByLoad(projects) {
        const now = Date.now();
        const recent = projects.filter(p => p.lastHealthCheck && now - p.lastHealthCheck.getTime() < 120000);
        const candidates = recent.length > 0 ? recent : projects;
        const totalWeight = candidates.reduce((sum, p) => sum + (p.loadWeight ?? 1), 0);
        let random = Math.random() * totalWeight;
        for (const project of candidates) {
            random -= project.loadWeight ?? 1;
            if (random <= 0)
                return project;
        }
        return candidates[candidates.length - 1];
    }
}
exports.databaseRegistry = new DatabaseRegistry();
//# sourceMappingURL=databaseRegistry.js.map