import express from 'express';
import { router } from '../src/api/routes';
import { middleware } from '../src/api/middleware';
import { infrastructureDb } from '../src/infrastructure/database/infrastructureDb';
import { projectManager } from '../src/project-manager';
import { configCenter } from '../src/config';
import { featureFlags } from '../src/features';
import { permissionEngine } from '../src/permissions';
import { jobQueue } from '../src/jobs/queue';

const app = express();
middleware(app);
app.get('/', (_req, res) => {
  res.json({
    name: 'Tone API Gateway',
    version: '1.0.0',
    docs: '/api/system/health',
  });
});
app.use('/api', router);

let initialized = false;
let initError: string | null = null;

async function initialize(): Promise<void> {
  try {
    await infrastructureDb.initialize();
  } catch (err) {
    console.error('[Gateway] Failed to connect to infrastructure DB, using in-memory fallback:', (err as Error).message);
    await infrastructureDb.initialize({ forceFallback: true });
  }

  try {
    await projectManager.load();
  } catch (err) {
    console.error('[Gateway] Failed to load projects:', (err as Error).message);
  }

  try {
    await configCenter.ensureLoaded();
  } catch (err) {
    console.error('[Gateway] Failed to load config:', (err as Error).message);
  }

  const projects = projectManager.getProjects();
  const domains = [...new Set(projects.map(p => p.domain))];
  for (const domain of domains) {
    featureFlags.enable(domain);
  }

  try {
    await configCenter.set('maxUploadSize', 10485760, 'number');
    await configCenter.set('aiModerationEnabled', true, 'boolean');
    await configCenter.set('softDeleteRetentionDays', 30, 'number');
  } catch (err) {
    console.error('[Gateway] Failed to set default config:', (err as Error).message);
  }

  permissionEngine.definePolicy('admin', ['*']);
  permissionEngine.definePolicy('user', [
    'posts:create', 'posts:read', 'posts:update', 'posts:delete',
    'comments:create', 'comments:read',
    'media:upload', 'media:read',
  ]);

  jobQueue.register('media.process', async (job) => {
    console.log(`Processing media job: ${job.id}`, job.payload);
  });

  jobQueue.register('notification.send', async (job) => {
    console.log(`Sending notification: ${job.id}`, job.payload);
  });

  initialized = true;
}

export default async function handler(req: any, res: any) {
  if (!initialized) {
    try {
      await initialize();
    } catch (err) {
      initError = (err as Error).message;
      console.error('[Gateway] Initialization failed:', initError);
    }
  }

  if (initError && !initialized) {
    res.status(503).json({ error: 'Gateway failed to initialize', details: initError });
    return;
  }

  app(req, res);
}
