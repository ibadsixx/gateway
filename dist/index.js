"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const routes_1 = require("./api/routes");
const middleware_1 = require("./api/middleware");
const monitoring_1 = require("./infrastructure/monitoring");
const features_1 = require("./features");
const config_1 = require("./config");
const permissions_1 = require("./permissions");
const infrastructureDb_1 = require("./infrastructure/database/infrastructureDb");
const queue_1 = require("./jobs/queue");
const project_manager_1 = require("./project-manager");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
(0, middleware_1.middleware)(app);
app.use('/api', routes_1.router);
async function initializeDefaults() {
    await infrastructureDb_1.infrastructureDb.initialize();
    await project_manager_1.projectManager.load();
    await config_1.configCenter.ensureLoaded();
    const projects = project_manager_1.projectManager.getProjects();
    const domains = [...new Set(projects.map(p => p.domain))];
    for (const domain of domains) {
        features_1.featureFlags.enable(domain);
    }
    await config_1.configCenter.set('maxUploadSize', 10485760, 'number');
    await config_1.configCenter.set('aiModerationEnabled', true, 'boolean');
    await config_1.configCenter.set('softDeleteRetentionDays', 30, 'number');
    permissions_1.permissionEngine.definePolicy('admin', ['*']);
    permissions_1.permissionEngine.definePolicy('user', ['posts:create', 'posts:read', 'posts:update', 'posts:delete',
        'comments:create', 'comments:read',
        'media:upload', 'media:read']);
    queue_1.jobQueue.register('media.process', async (job) => {
        console.log(`Processing media job: ${job.id}`, job.payload);
    });
    queue_1.jobQueue.register('notification.send', async (job) => {
        console.log(`Sending notification: ${job.id}`, job.payload);
    });
    monitoring_1.monitoring.start();
    setInterval(() => {
        project_manager_1.projectManager.refreshRegistry().catch(err => console.error('[Cache] Periodic registry refresh failed:', err));
    }, 60000);
    console.log('Tone API Gateway initialized with all services');
}
if (process.env.VERCEL !== '1') {
    initializeDefaults()
        .then(() => {
        app.listen(PORT, () => {
            console.log(`Tone API Gateway running on port ${PORT}`);
        });
    })
        .catch((error) => {
        console.error('Failed to initialize Gateway:', error);
        process.exit(1);
    });
}
exports.default = app;
//# sourceMappingURL=index.js.map