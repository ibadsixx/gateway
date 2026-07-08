"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const validation_1 = require("./validation");
const database_1 = require("../infrastructure/database");
const storage_1 = require("../infrastructure/storage");
const ai_1 = require("../infrastructure/ai");
const projectRegistry_1 = require("../registry/projectRegistry");
const features_1 = require("../features");
const config_1 = require("../config");
const metrics_1 = require("../metrics");
const audit_1 = require("../audit");
const registry_1 = require("../discovery/registry");
const queue_1 = require("../jobs/queue");
const notifications_1 = require("../notifications");
const search_1 = require("../search");
const project_manager_1 = require("../project-manager");
const v1 = (0, express_1.Router)();
v1.post('/:domain', validation_1.validation.validateDomainMiddleware, async (req, res) => {
    const { domain } = req.params;
    if (!features_1.featureFlags.isEnabled(domain)) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    try {
        const result = await database_1.database.write(domain, req.body);
        res.status(201).json(result);
    }
    catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
v1.get('/:domain/:id', validation_1.validation.validateDomainMiddleware, async (req, res) => {
    const { domain, id } = req.params;
    if (!features_1.featureFlags.isEnabled(domain)) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    try {
        const result = await database_1.database.read(domain, id);
        if (!result) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
v1.put('/:domain/:id', validation_1.validation.validateDomainMiddleware, async (req, res) => {
    const { domain, id } = req.params;
    if (!features_1.featureFlags.isEnabled(domain)) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    try {
        const result = await database_1.database.update(domain, id, req.body);
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
v1.delete('/:domain/:id', validation_1.validation.validateDomainMiddleware, async (req, res) => {
    const { domain, id } = req.params;
    if (!features_1.featureFlags.isEnabled(domain)) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    const permanent = req.query.permanent === 'true';
    try {
        await database_1.database.delete(domain, id, permanent);
        res.status(204).send();
    }
    catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
v1.post('/media/upload', async (req, res) => {
    try {
        const result = await storage_1.storage.upload(req.body);
        res.status(201).json(result);
    }
    catch (error) {
        res.status(500).json({ error: 'Upload failed' });
    }
});
v1.post('/moderation/text', async (req, res) => {
    try {
        const result = await ai_1.ai.moderateText(req.body.content);
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: 'Moderation failed' });
    }
});
v1.post('/moderation/image', async (req, res) => {
    try {
        const result = await ai_1.ai.moderateImage(req.body.url);
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: 'Moderation failed' });
    }
});
v1.get('/search/:domain', async (req, res) => {
    const { domain } = req.params;
    const query = req.query.q;
    if (!query) {
        res.status(400).json({ error: 'Query parameter q is required' });
        return;
    }
    try {
        const results = await search_1.searchService.search(domain, query);
        res.json(results);
    }
    catch (error) {
        res.status(500).json({ error: 'Search failed' });
    }
});
v1.post('/notifications/send', async (req, res) => {
    try {
        const notification = notifications_1.notificationQueue.enqueue(req.body);
        res.status(201).json(notification);
    }
    catch (error) {
        res.status(500).json({ error: 'Notification failed' });
    }
});
const system = (0, express_1.Router)();
system.get('/health', (_req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });
});
system.get('/storage', async (_req, res) => {
    const status = await projectRegistry_1.projectRegistry.getInfrastructureStatus();
    res.json(status.storage);
});
system.get('/databases', async (_req, res) => {
    const status = await projectRegistry_1.projectRegistry.getInfrastructureStatus();
    res.json(status.databases);
});
system.get('/metrics', (_req, res) => {
    res.json(metrics_1.metricsService.getSnapshot());
});
system.get('/audit', (_req, res) => {
    res.json(audit_1.auditLogger.getAll());
});
system.get('/config', async (_req, res) => {
    const config = await config_1.configCenter.getAll();
    res.json(config);
});
system.get('/features', (_req, res) => {
    res.json(features_1.featureFlags.getAll());
});
system.get('/services', (_req, res) => {
    res.json(registry_1.serviceDiscovery.getAllServices());
});
system.get('/queue', (_req, res) => {
    res.json({ pending: queue_1.jobQueue.length });
});
system.get('/rate-limits', (_req, res) => {
    res.json({ message: 'Check X-RateLimit headers on responses' });
});
system.post('/reload-registry', async (_req, res) => {
    try {
        await project_manager_1.projectManager.refreshRegistry();
        res.json({ status: 'ok', message: 'Registry cache reloaded' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to reload registry' });
    }
});
const router = (0, express_1.Router)();
exports.router = router;
router.use('/v1', v1);
router.use('/system', system);
router.get('/health', (_req, res) => {
    res.redirect('/api/system/health');
});
//# sourceMappingURL=routes.js.map