import { Router, Request, Response } from 'express';
import busboy from 'busboy';
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
import { auth, AuthCredentials } from '../auth';
import { projectHealth } from '../project-health';
import { infrastructureDb } from '../infrastructure/database/infrastructureDb';
import { authRouter } from './auth';
import { realtimeRouter } from './realtime';

function requireProbeToken(req: Request, res: Response, next: () => void): void {
  const expected = process.env.KEEP_ALIVE_TOKEN || process.env.CRON_SECRET;
  if (!expected) {
    next();
    return;
  }
  if (req.headers.authorization === `Bearer ${expected}`) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

function applySupabaseFilters(query: any, filters: string | string[] | undefined): any {
  if (!filters) return query;
  const filterList = Array.isArray(filters) ? filters : [filters];
  for (const f of filterList) {
    const eqIdx = f.indexOf('=');
    if (eqIdx === -1) continue;
    const column = f.slice(0, eqIdx);
    const rest = f.slice(eqIdx + 1);
    const dotIdx = rest.indexOf('.');
    if (dotIdx === -1) continue;
    const op = rest.slice(0, dotIdx);
    const value = rest.slice(dotIdx + 1);
    switch (op) {
      case 'eq': query = query.eq(column, value); break;
      case 'neq': query = query.neq(column, value); break;
      case 'gt': query = query.gt(column, value); break;
      case 'gte': query = query.gte(column, value); break;
      case 'lt': query = query.lt(column, value); break;
      case 'lte': query = query.lte(column, value); break;
      case 'like': query = query.like(column, value); break;
      case 'ilike': query = query.ilike(column, value); break;
      case 'in': {
        const items = value.replace(/^\(|\)$/g, '').split(',');
        query = query.in(column, items);
        break;
      }
      default: break;
    }
  }
  return query;
}

const v1 = Router();

const MAX_UPLOAD_SIZE = 150 * 1024 * 1024;

function parseMultipartUpload(req: Request): Promise<{ buffer: Buffer; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD_SIZE, fields: 10 } });
    let buffer = Buffer.alloc(0);
    let mimeType = 'application/octet-stream';

    bb.on('file', (_name, stream, info) => {
      mimeType = info.mimeType || mimeType;
      stream.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
      });
    });

    bb.on('error', (err) => reject(err));

    bb.on('close', () => {
      if (buffer.length === 0) {
        reject(new Error('No file received'));
        return;
      }
      resolve({ buffer, mimeType });
    });

    req.pipe(bb);
  });
}

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

v1.delete('/:domain', validation.validateDomainMiddleware, async (req, res) => {
  const { domain } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const filters = req.query.filter as string[] | string | undefined;
  const permanent = req.query.permanent === 'true';
  if (!filters) {
    res.status(400).json({ error: 'No filters provided' });
    return;
  }
  try {
    const readableProjects = projectManager.getReadableProjects(domain);
    for (const entry of readableProjects) {
      try {
        let query = entry.client.from(domain).select('*');
        query = applySupabaseFilters(query, filters);
        const { data } = await query;
        if (data && (data as any[]).length > 0) {
          for (const row of data as any[]) {
            if (row.id) {
              await entry.client.from(domain).delete().eq('id', row.id);
            } else {
              let del = entry.client.from(domain).delete();
              for (const f of (Array.isArray(filters) ? filters : [filters])) {
                const eqIdx = f.indexOf('=');
                if (eqIdx === -1) continue;
                const col = f.slice(0, eqIdx);
                const rest = f.slice(eqIdx + 1);
                const dotIdx = rest.indexOf('.');
                if (dotIdx === -1) continue;
                const val = rest.slice(dotIdx + 1);
                del = del.eq(col, val);
              }
              await del;
            }
          }
        }
      } catch { /* skip */ }
    }
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

// Public: health check only
system.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// All remaining system endpoints require admin authentication
system.use(auth.authenticateAdmin.bind(auth));

system.get('/storage', async (_req, res) => {
  const status = await projectRegistry.getInfrastructureStatus();
  res.json(status.storage);
});

// /databases endpoint REMOVED — it exposed all Supabase service keys publicly.
// Use the Supabase Management API or direct project access for database operations.

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

const rpcRouter = Router();

// RPC functions that must run against a non-default project.
// The default RPC proxy targets the 'users' project; functions that operate on
// tables hosted elsewhere (e.g. ad topics in the advertisers project) are routed
// here by name to their owning domain. These are SECURITY DEFINER functions that
// take explicit parameters, so they run with the owning project's anon key.
const RPC_DOMAIN_OVERRIDES: Record<string, string> = {
  seed_default_ad_topics: 'ad_topics',
  add_blocked_nickname: 'blocking',
  add_blocked_sender: 'blocking',
  get_blocked_nicknames: 'blocking',
  remove_blocked_nickname: 'blocking',
  remove_blocked_sender: 'blocking',
  block_user: 'blocking',
  unblock_user: 'blocking',
  get_blocked_users: 'blocking',
  get_blocked_senders: 'blocking',
  get_blocked_user_ids: 'blocking',
  get_restricted_users: 'blocking',
  get_user_blocks: 'blocking',
  get_block_relation: 'blocking',
  is_blocked: 'blocking',
  is_restricted: 'blocking',
  restrict_user: 'blocking',
  unrestrict_user: 'blocking',
};

rpcRouter.post('/:function', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  try {
    const domain = RPC_DOMAIN_OVERRIDES[req.params.function] || 'users';
    let credentials: AuthCredentials | null = null;
    let bearer: string | null = null;

    if (domain === 'users') {
      credentials = await auth.getProjectCredentials('users');
      bearer = auth.extractTokenFromHeader(req.headers.authorization);
    } else {
      const projects = projectManager.getReadableProjects(domain);
      const project = projects[0];
      if (project) {
        credentials = {
          project_url: project.project.projectUrl,
          anon_key: project.project.anonKey,
          service_key: project.project.serviceKey,
          jwt_secret: '',
        };
        // Functions routed to a non-default project run as that project's anon role
        // (they are SECURITY DEFINER and receive the acting user explicitly).
        bearer = project.project.anonKey;
      }
    }

    if (!credentials) {
      res.status(500).json({ error: 'Auth service not configured' });
      return;
    }
    if (!bearer) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }

    const url = `${credentials.project_url}/rest/v1/rpc/${encodeURIComponent(req.params.function)}`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: credentials.anon_key,
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(req.body || {}),
    });

    const text = await upstream.text();

    if (upstream.status === 204) {
      res.status(200).json(null);
      return;
    }

    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!upstream.ok) {
      const message =
        (payload && typeof payload === 'object' && (payload as any).message) ||
        (payload && typeof payload === 'object' && (payload as any).msg) ||
        `RPC failed (${upstream.status})`;
      res.status(upstream.status === 404 ? 400 : upstream.status).json({ error: message });
      return;
    }

    res.status(200).json(payload);
  } catch (error) {
    console.error('[Gateway] RPC proxy error:', error);
    res.status(502).json({ error: 'RPC proxy failed' });
  }
});

const router = Router();
router.use('/auth', authRouter);
router.use('/rpc', rpcRouter);
router.use('/realtime', realtimeRouter);
router.use('/v1', v1);
router.use('/system', system);
router.get('/health', (_req, res) => {
  res.redirect('/api/system/health');
});

// Apply auth middleware to non-v1 domain routes
router.post('/storage/:bucket/*', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  const { bucket } = req.params;
  const path = req.params[0];
  if (!bucket || !path) {
    res.status(400).json({ error: 'bucket and path are required' });
    return;
  }
  try {
    const { buffer, mimeType } = await parseMultipartUpload(req);
    const result = await storage.upload({ buffer, mimeType, bucket, path });
    res.status(201).json(result);
  } catch (error) {
    console.error('[Gateway] Storage upload failed:', (error as Error).message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Project Health service — canonical mount plus the deprecated `/keep-alive` alias.
const projectHealthRouter = Router();

projectHealthRouter.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await projectHealth.getStatus());
  } catch (error) {
    console.error('[ProjectHealth] Status failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to collect project health status' });
  }
});

projectHealthRouter.get('/history/:projectKey', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
    const logs = await infrastructureDb.getHealthLogs('database', req.params.projectKey, limit);
    res.json(logs);
  } catch (error) {
    console.error('[ProjectHealth] History failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to load project health history' });
  }
});

// Vercel Cron sends GET; manual operators use POST. Default action is a
// scheduler tick (probes only projects whose slot is due); `?force=1` runs a
// full immediate round over every active project.
const runHandler = async (req: Request, res: Response) => {
  try {
    const force = String(req.query.force ?? '') === '1' || 'true';
    const result = force ? await projectHealth.runAll() : await projectHealth.tick();
    res.json(result);
  } catch (error) {
    console.error('[ProjectHealth] Run failed:', (error as Error).message);
    res.status(500).json({ error: 'Project health round failed' });
  }
};

projectHealthRouter.post('/run', requireProbeToken, runHandler);
projectHealthRouter.get('/run', requireProbeToken, runHandler);

// Registered before the top-level /:domain wildcards so they are never shadowed.
router.use('/project-health', projectHealthRouter);
/** @deprecated legacy alias — use /api/project-health instead. */
router.use('/keep-alive', projectHealthRouter);

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

// Auth users live in the users project's `auth.users` schema, and there is no
// public `users` table, so the generic /:domain read below would return [] for
// "users". List them via the admin API instead and expose a stripped-down shape
// (`raw_user_meta_data` mirrors GoTrue's user_metadata) consistent with other
// domain rows the frontend reads.
router.get('/users', auth.authenticate.bind(auth), async (_req, res) => {
  try {
    const supabase = await auth.getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: 'Auth service not configured' });
      return;
    }
    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json(
      (data?.users || []).map((u) => ({
        id: u.id,
        email: u.email ?? null,
        raw_user_meta_data: u.user_metadata ?? null,
        created_at: u.created_at ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
      }))
    );
  } catch (error) {
    console.error('[Auth] List users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:domain', auth.authenticate.bind(auth), validation.validateDomainMiddleware, async (req, res) => {
  const { domain } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const readableProjects = projectManager.getReadableProjects(domain);
    if (readableProjects.length === 0) {
      res.json([]);
      return;
    }
    const filters = req.query.filter as string[] | string | undefined;
    const results = await Promise.all(
      readableProjects.map(async (entry) => {
        try {
          let query = entry.client.from(domain).select('*');
          query = applySupabaseFilters(query, filters);
          const { data, error } = await query;
          if (error) return [];
          return (data as any[]) || [];
        } catch {
          return [];
        }
      })
    );
    res.json(results.flat());
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
