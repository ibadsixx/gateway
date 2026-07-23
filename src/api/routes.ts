import { Router } from 'express';
import { validation } from './validation';
import { database } from '../infrastructure/database';
import { storage } from '../infrastructure/storage';
import { ai } from '../infrastructure/ai';
import { projectRegistry } from '../registry/projectRegistry';
import { featureFlags } from '../features';
import { configCenter } from '../config';
import { rateLimiter } from '../rate-limiting';
import { metricsService } from '../metrics';
import { auditLogger } from '../audit';
import { serviceDiscovery } from '../discovery/registry';
import { eventBus } from '../events/bus';
import { jobQueue } from '../jobs/queue';
import { notificationQueue } from '../notifications';
import { searchService } from '../search';
import { projectManager } from '../project-manager';
import { auth } from '../auth';
import { authRouter } from './auth';

const v1 = Router();

// Apply auth middleware to all v1 routes except system endpoints
v1.use((req, res, next) => {
  // Skip auth for system endpoints
  if (req.path.startsWith('/system') || req.path === '/health') {
    return next();
  }
  return auth.authenticate(req, res, next);
});

v1.post('/:domain', validation.validateDomainMiddleware, async (req, res) => {
  const { domain } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const result = await database.write(domain, req.body);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

v1.get('/:domain/:id', validation.validateDomainMiddleware, async (req, res) => {
  const { domain, id } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const result = await database.read(domain, id);
    if (!result) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

v1.put('/:domain/:id', validation.validateDomainMiddleware, async (req, res) => {
  const { domain, id } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const result = await database.update(domain, id, req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

v1.delete('/:domain/:id', validation.validateDomainMiddleware, async (req, res) => {
  const { domain, id } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const permanent = req.query.permanent === 'true';
  try {
    await database.delete(domain, id, permanent);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

v1.post('/media/upload', async (req, res) => {
  try {
    const result = await storage.upload(req.body);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Upload failed' });
  }
});

v1.post('/moderation/text', async (req, res) => {
  try {
    const result = await ai.moderateText(req.body.content);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Moderation failed' });
  }
});

v1.post('/moderation/image', async (req, res) => {
  try {
    const result = await ai.moderateImage(req.body.url);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Moderation failed' });
  }
});

v1.get('/search/:domain', async (req, res) => {
  const { domain } = req.params;
  const query = req.query.q as string;
  if (!query) {
    res.status(400).json({ error: 'Query parameter q is required' });
    return;
  }
  try {
    const results = await searchService.search(domain, query);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

v1.post('/notifications/send', async (req, res) => {
  try {
    const notification = notificationQueue.enqueue(req.body);
    res.status(201).json(notification);
  } catch (error) {
    res.status(500).json({ error: 'Notification failed' });
  }
});

const system = Router();

system.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

system.get('/storage', async (_req, res) => {
  const status = await projectRegistry.getInfrastructureStatus();
  res.json(status.storage);
});

system.get('/databases', async (_req, res) => {
  const status = await projectRegistry.getInfrastructureStatus();
  res.json(status.databases);
});

system.get('/metrics', (_req, res) => {
  res.json(metricsService.getSnapshot());
});

system.get('/audit', (_req, res) => {
  res.json(auditLogger.getAll());
});

system.get('/config', async (_req, res) => {
  const config = await configCenter.getAll();
  res.json(config);
});

system.get('/features', (_req, res) => {
  res.json(featureFlags.getAll());
});

system.get('/services', (_req, res) => {
  res.json(serviceDiscovery.getAllServices());
});

system.get('/queue', (_req, res) => {
  res.json({ pending: jobQueue.length });
});

system.get('/rate-limits', (_req, res) => {
  res.json({ message: 'Check X-RateLimit headers on responses' });
});

system.post('/reload-registry', async (_req, res) => {
  try {
    await projectManager.refreshRegistry();
    res.json({ status: 'ok', message: 'Registry cache reloaded' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reload registry' });
  }
});

const router = Router();
router.use('/auth', authRouter);
router.use('/v1', v1);
router.use('/system', system);
router.get('/health', (_req, res) => {
  res.redirect('/api/system/health');
});

// Apply auth middleware to non-v1 domain routes
router.post('/:domain', auth.authenticate.bind(auth), validation.validateDomainMiddleware, async (req, res) => {
  const { domain } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const result = await database.write(domain, req.body);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:domain/:id', auth.authenticate.bind(auth), validation.validateDomainMiddleware, async (req, res) => {
  const { domain, id } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const result = await database.read(domain, id);
    if (!result) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router };
