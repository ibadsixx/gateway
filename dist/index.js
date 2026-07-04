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
const bus_1 = require("./events/bus");
const queue_1 = require("./jobs/queue");
const search_1 = require("./search");
const infrastructureDb_1 = require("./infrastructure/database/infrastructureDb");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
(0, middleware_1.middleware)(app);
app.use('/api', routes_1.router);
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
async function initializeDefaults() {
    await infrastructureDb_1.infrastructureDb.initialize();
    await config_1.configCenter.ensureLoaded();
    features_1.featureFlags.enable('posts');
    features_1.featureFlags.enable('comments');
    features_1.featureFlags.enable('stories');
    features_1.featureFlags.enable('users');
    features_1.featureFlags.enable('conversations');
    features_1.featureFlags.enable('groups');
    features_1.featureFlags.enable('pages');
    features_1.featureFlags.enable('reports');
    features_1.featureFlags.enable('media');
    features_1.featureFlags.enable('notifications');
    features_1.featureFlags.enable('blocking');
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
    bus_1.eventBus.on('post.created', async (event) => {
        queue_1.jobQueue.enqueue('notification.send', {
            userId: event.payload.id,
            title: 'Post Created',
            body: 'Your post has been published',
        });
        await search_1.searchService.index('posts', event.payload.id, event.payload.data);
    });
    monitoring_1.monitoring.start();
    console.log('Tone API Gateway initialized with all services');
}
exports.default = app;
//# sourceMappingURL=index.js.map