"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseRegistry = void 0;
const project_manager_1 = require("../project-manager");
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
function toLegacyProject(info) {
    return {
        id: info.id,
        domain: info.domain,
        provider: '',
        status: toLegacyStatus(info.status),
        priority: info.priority,
        capacity: info.capacity,
        usedSpace: info.usedSpace,
        connectionName: info.projectUrl,
        projectUrl: info.projectUrl || undefined,
        serviceKey: info.serviceKey || undefined,
        anonKey: info.anonKey || undefined,
        region: info.region || undefined,
        responseTime: info.responseTime ?? undefined,
        loadWeight: info.loadWeight,
        writeEnabled: info.writeEnabled,
        healthStatus: info.healthStatus || undefined,
        lastHealthCheck: info.lastHealthCheck ? new Date(info.lastHealthCheck) : undefined,
    };
}
class DatabaseRegistry {
    async register(project) {
        const dbProviders = await this.getProviders();
        const providerRow = dbProviders.find(p => p.name.toLowerCase() === project.provider.toLowerCase())
            || dbProviders.find(p => p.type === 'database');
        await project_manager_1.projectManager.register({
            projectKey: project.id || project.project_key || `${project.domain}_${Date.now()}`,
            domain: project.domain,
            providerId: providerRow?.id || crypto.randomUUID(),
            projectUrl: project.projectUrl || project.connectionName || '',
            serviceKey: project.serviceKey || '',
            anonKey: project.anonKey || '',
            status: toDbStatus(project.status),
            capacity: project.capacity,
            usedSpace: project.usedSpace,
            priority: project.priority,
            loadWeight: project.loadWeight ?? 100,
        });
        const domainRow = await this.getDomain(project.domain);
        const allProjects = await project_manager_1.projectManager.getProjects(project.domain);
        const activeProjects = allProjects.filter(p => p.status === 'active');
        const firstActive = activeProjects.length > 0
            ? activeProjects.reduce((a, b) => a.priority <= b.priority ? a : b)
            : null;
        if (!domainRow) {
            await this.registerDomain({
                name: project.domain,
                current_write_project: firstActive?.id || null,
            });
        }
        else if (!domainRow.current_write_project && firstActive) {
            await this.setCurrentWriteProject(project.domain, firstActive.id);
        }
    }
    async getWritableProject(domain) {
        const entry = project_manager_1.projectManager.getWritableProject(domain);
        return entry ? toLegacyProject(entry.project) : undefined;
    }
    async getActiveProjects(domain) {
        const projects = project_manager_1.projectManager.getReadableProjects(domain);
        return projects.map(e => toLegacyProject(e.project));
    }
    async getActiveProject(domain) {
        const active = await this.getActiveProjects(domain);
        if (active.length === 0)
            return undefined;
        if (active.length === 1)
            return active[0];
        const writeTarget = await this.getCurrentWriteProject(domain);
        if (writeTarget) {
            const match = active.find(p => p.id === writeTarget.id);
            if (match)
                return match;
        }
        return this.selectByLoad(active);
    }
    async getProjectById(id) {
        const info = await project_manager_1.projectManager.getProject(id);
        return info ? toLegacyProject(info) : undefined;
    }
    async updateStatus(id, status) {
        await project_manager_1.projectManager.updateStatus(id, toDbStatus(status));
    }
    async updateHealth(id, responseTime, usedSpace) {
        await project_manager_1.projectManager.updateHealth(id, responseTime, usedSpace);
    }
    async getAllProjects() {
        const projects = await project_manager_1.projectManager.getProjects();
        return projects.map(toLegacyProject);
    }
    async getProjectsByDomain(domain) {
        const projects = await project_manager_1.projectManager.getProjects(domain);
        return projects.map(toLegacyProject);
    }
    async getProviders() {
        return infrastructureDb_1.infrastructureDb.getProviders();
    }
    async getDomain(name) {
        return infrastructureDb_1.infrastructureDb.getDomain(name);
    }
    async registerDomain(data) {
        return infrastructureDb_1.infrastructureDb.registerDomain({
            name: data.name,
            current_write_project: data.current_write_project,
            next_project: null,
        });
    }
    async setCurrentWriteProject(domain, projectId) {
        return infrastructureDb_1.infrastructureDb.setCurrentWriteProject(domain, projectId);
    }
    async getCurrentWriteProject(domain) {
        return infrastructureDb_1.infrastructureDb.getCurrentWriteProject(domain);
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