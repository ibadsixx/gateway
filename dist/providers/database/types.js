"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectionConfigFromProject = connectionConfigFromProject;
function connectionConfigFromProject(project) {
    const url = project.projectUrl || project.project_url;
    const key = project.serviceKey || project.service_key;
    const anon = project.anonKey || project.anon_key || '';
    if (url && key) {
        return { projectUrl: url, serviceKey: key, anonKey: anon };
    }
    return undefined;
}
//# sourceMappingURL=types.js.map