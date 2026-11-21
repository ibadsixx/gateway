// Tone API Gateway — long-running HTTP/WebSocket server for Docker / HF Spaces.
//
// This is the container entrypoint. It preserves the existing Express API and
// the /api/live/signaling WebSocket endpoint by attaching the shared signaling
// handler to the same Node http.Server that serves Express. It listens on
// 0.0.0.0 and on the Hugging Face exposed port (7860 by default).

import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import { router } from './api/routes';
import { middleware } from './api/middleware';
import { attachLiveSignaling } from './features/liveSignalingServer';
import { monitoring } from './infrastructure/monitoring';
import { featureFlags } from './features';
import { configCenter } from './config';
import { permissionEngine } from './permissions';
import { infrastructureDb } from './infrastructure/database/infrastructureDb';
import { jobQueue } from './jobs/queue';
import { projectManager } from './project-manager';
import { projectHealth } from './project-health';

const HOST = process.env.HOST || '0.0.0.0';
const portFromEnv = Number(process.env.PORT ?? 7860);
const PORT = Number.isInteger(portFromEnv) && portFromEnv > 0 && portFromEnv < 65536
  ? portFromEnv
  : 7860;

const app = express();
middleware(app);

app.get('/', (_req, res) => {
  res.json({
    name: 'Tone API Gateway',
    version: '1.0.0',
    docs: '/api/system/health',
  });
});

// The Vercel signaling Function answers plain HTTP on its own path. The Docker
// server owns every path, so preserve that response before mounting the router.
app.get('/api/live/signaling', (_req, res) => {
  res.json({ name: 'Tone Live signaling', ok: true });
});

app.use('/api', router);

let registryRefreshTimer: ReturnType<typeof setInterval> | null = null;

async function initializeDefaults(): Promise<void> {
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
  const domains = [...new Set(projects.map((p) => p.domain))];
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

  monitoring.start();
  projectHealth.start();
  projectHealth.tick().catch((err) =>
    console.error('[KeepAlive] Initial tick failed:', (err as Error).message),
  );

  registryRefreshTimer = setInterval(() => {
    projectManager.refreshRegistry()
      .then(() => {
        const refreshed = projectManager.getProjects();
        for (const domain of [...new Set(refreshed.map((p) => p.domain))]) {
          featureFlags.enable(domain);
        }
      })
      .catch((err) =>
        console.error('[Cache] Periodic registry refresh failed:', err),
      );
  }, 60000);

  console.log('Tone API Gateway initialized with all services');
}

const server = http.createServer(app);
const signalingWss = attachLiveSignaling(server);

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Gateway] ${signal} received; shutting down`);

  const forceExitTimer = setTimeout(() => {
    console.error('[Gateway] Graceful shutdown timed out; forcing exit');
    for (const client of signalingWss.clients) client.terminate();
    server.closeAllConnections?.();
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  if (registryRefreshTimer) clearInterval(registryRefreshTimer);
  monitoring.stop();
  projectHealth.stop();

  for (const client of signalingWss.clients) {
    client.close(1001, 'server_shutdown');
  }

  signalingWss.close(() => {
    server.close(() => {
      clearTimeout(forceExitTimer);
      console.log('[Gateway] Shutdown complete');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.on('error', (error) => {
  console.error('[Gateway] HTTP server error:', error.message);
  process.exit(1);
});

initializeDefaults()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`Tone API Gateway (Docker) listening on ${HOST}:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize Gateway:', error);
    process.exit(1);
  });
