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
const databaseRegistry_1 = require("./registry/databaseRegistry");
const storageRegistry_1 = require("./registry/storageRegistry");
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
    await databaseRegistry_1.databaseRegistry.register({
        id: 'posts-1',
        domain: 'posts',
        provider: 'supabase',
        status: 'ACTIVE',
        priority: 1,
        capacity: 1000000000,
        usedSpace: 500000000,
        connectionName: 'supabase_posts_1',
        loadWeight: 50,
    });
    await databaseRegistry_1.databaseRegistry.register({
        id: 'posts-2',
        domain: 'posts',
        provider: 'supabase',
        status: 'ACTIVE',
        priority: 2,
        capacity: 1000000000,
        usedSpace: 100000000,
        connectionName: 'supabase_posts_2',
        loadWeight: 30,
    });
    await databaseRegistry_1.databaseRegistry.register({
        id: 'posts-3',
        domain: 'posts',
        provider: 'supabase',
        status: 'ACTIVE',
        priority: 3,
        capacity: 1000000000,
        usedSpace: 10000000,
        connectionName: 'supabase_posts_3',
        loadWeight: 20,
    });
    await databaseRegistry_1.databaseRegistry.register({
        id: 'comments-1',
        domain: 'comments',
        provider: 'supabase',
        status: 'ACTIVE',
        priority: 1,
        capacity: 500000000,
        usedSpace: 200000000,
        connectionName: 'supabase_comments_1',
        loadWeight: 50,
    });
    await databaseRegistry_1.databaseRegistry.register({
        id: 'comments-2',
        domain: 'comments',
        provider: 'supabase',
        status: 'ACTIVE',
        priority: 2,
        capacity: 500000000,
        usedSpace: 50000000,
        connectionName: 'supabase_comments_2',
        loadWeight: 30,
    });
    await databaseRegistry_1.databaseRegistry.register({
        id: 'comments-3',
        domain: 'comments',
        provider: 'supabase',
        status: 'ACTIVE',
        priority: 3,
        capacity: 500000000,
        usedSpace: 10000000,
        connectionName: 'supabase_comments_3',
        loadWeight: 20,
    });
    await databaseRegistry_1.databaseRegistry.register({
        id: 'stories-1',
        domain: 'stories',
        provider: 'supabase',
        status: 'ACTIVE',
        priority: 1,
        capacity: 300000000,
        usedSpace: 150000000,
        connectionName: 'supabase_stories_1',
    });
    await databaseRegistry_1.databaseRegistry.register({
        id: 'conversations-1',
        domain: 'conversations',
        provider: 'supabase',
        status: 'ACTIVE',
        priority: 1,
        capacity: 500000000,
        usedSpace: 0,
        connectionName: 'sbp_f34579f61778d8ab2a7f46d0800a6654a7cea67f',
        loadWeight: 100,
    });
    await storageRegistry_1.storageRegistry.register({
        id: 'cloudinary-1',
        provider: 'cloudinary',
        status: 'ACTIVE',
        capacity: 10000000000,
        usedSpace: 9500000000,
        priority: 1,
    });
    await storageRegistry_1.storageRegistry.register({
        id: 'cloudinary-2',
        provider: 'cloudinary',
        status: 'ACTIVE',
        capacity: 10000000000,
        usedSpace: 1000000000,
        priority: 2,
    });
    await storageRegistry_1.storageRegistry.register({
        id: 's3-main',
        provider: 's3',
        status: 'ACTIVE',
        capacity: 50000000000,
        usedSpace: 5000000000,
        priority: 3,
    });
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