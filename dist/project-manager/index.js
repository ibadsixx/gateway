"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectManager = void 0;
const crypto_1 = require("crypto");
const client_factory_1 = require("../client-factory");
const infrastructureDb_1 = require("../infrastructure/database/infrastructureDb");
function toProjectInfo(row) {
    return {
        id: row.id,
        projectKey: row.project_key,
        domain: row.domain,
        providerId: row.provider_id,
        projectUrl: row.project_url,
        serviceKey: row.service_key,
        anonKey: row.anon_key,
        status: row.status,
        capacity: row.capacity,
        usedSpace: row.used_space,
        priority: row.priority,
        loadWeight: row.load_weight,
        writeEnabled: row.write_enabled !== false,
        healthStatus: row.health_status || null,
        region: row.region || null,
        responseTime: row.response_time ?? null,
        lastHealthCheck: row.last_health_check || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
class ProjectManager {
    cache = new Map();
    async load() {
        const rows = await infrastructureDb_1.infrastructureDb.getProjects();
        const grouped = new Map();
        for (const row of rows) {
            const project = toProjectInfo(row);
            const cached = {
                project,
                client: client_factory_1.clientFactory.getClientFromProject(project),
            };
            const domain = row.domain;
            if (!grouped.has(domain))
                grouped.set(domain, []);
            grouped.get(domain).push(cached);
        }
        this.cache = grouped;
    }
    async refreshRegistry() {
        await this.load();
    }
    getWritableProject(domain) {
        const entries = this.cache.get(domain);
        if (!entries)
            return null;
        const candidates = entries.filter(e => e.project.writeEnabled
            && e.project.status === 'active'
            && e.project.healthStatus !== 'offline'
            && (e.project.capacity <= 0 || (e.project.usedSpace / e.project.capacity) * 100 < 90));
        if (candidates.length === 0)
            return null;
        return candidates.reduce((a, b) => a.project.priority <= b.project.priority ? a : b);
    }
    getReadableProjects(domain) {
        const entries = this.cache.get(domain);
        if (!entries)
            return [];
        return entries.filter(e => e.project.status === 'active');
    }
    getReadClient(domain, entityId) {
        const projects = this.getReadableProjects(domain);
        if (projects.length === 0) {
            throw new Error(`No readable projects for domain: ${domain}`);
        }
        if (projects.length === 1)
            return projects[0];
        const hashNum = parseInt((0, crypto_1.createHash)('md5').update(entityId).digest('hex').substring(0, 8), 16);
        return projects[hashNum % projects.length];
    }
    getProject(id) {
        for (const entries of this.cache.values()) {
            const found = entries.find(e => e.project.id === id);
            if (found)
                return found.project;
        }
        return null;
    }
    getProjects(domain) {
        if (domain) {
            const entries = this.cache.get(domain);
            return entries ? entries.map(e => e.project) : [];
        }
        const all = [];
        for (const entries of this.cache.values()) {
            for (const e of entries)
                all.push(e.project);
        }
        return all;
    }
    getProjectByKey(key) {
        for (const entries of this.cache.values()) {
            const found = entries.find(e => e.project.projectKey === key);
            if (found)
                return found.project;
        }
        return null;
    }
    async register(project) {
        const row = await infrastructureDb_1.infrastructureDb.registerProject({
            project_key: project.projectKey || `${project.domain}_${Date.now()}`,
            domain: project.domain,
            provider_id: project.providerId,
            project_url: project.projectUrl,
            service_key: project.serviceKey,
            anon_key: project.anonKey,
            status: project.status,
            capacity: project.capacity,
            used_space: project.usedSpace,
            priority: project.priority,
            load_weight: project.loadWeight ?? 100,
            region: project.region ?? null,
            response_time: null,
            last_health_check: null,
        });
        const info = toProjectInfo(row);
        const cached = {
            project: info,
            client: client_factory_1.clientFactory.getClientFromProject(info),
        };
        if (!this.cache.has(info.domain))
            this.cache.set(info.domain, []);
        this.cache.get(info.domain).push(cached);
        return info;
    }
    async updateStatus(id, status) {
        await infrastructureDb_1.infrastructureDb.updateProjectStatus(id, status);
        for (const entries of this.cache.values()) {
            const entry = entries.find(e => e.project.id === id);
            if (entry) {
                entry.project.status = status;
                entry.project.lastHealthCheck = new Date().toISOString();
                return;
            }
        }
    }
    async updateHealth(id, responseTime, usedSpace) {
        await infrastructureDb_1.infrastructureDb.updateProjectHealth(id, responseTime, usedSpace);
        for (const entries of this.cache.values()) {
            const entry = entries.find(e => e.project.id === id);
            if (entry) {
                entry.project.responseTime = responseTime;
                entry.project.usedSpace = usedSpace;
                entry.project.lastHealthCheck = new Date().toISOString();
                return;
            }
        }
    }
}
exports.projectManager = new ProjectManager();
//# sourceMappingURL=index.js.map