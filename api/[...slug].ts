import express from 'express';
import { router } from '../../src/api/routes';
import { middleware } from '../../src/api/middleware';

const app = express();
middleware(app);
app.use('/api', router);

let initialized = false;

async function init() {
  if (initialized) return;
  const { infrastructureDb } = await import('../../src/infrastructure/database/infrastructureDb');
  const { projectManager } = await import('../../src/project-manager');
  const { configCenter } = await import('../../src/config');
  const { featureFlags } = await import('../../src/features');

  try {
    await infrastructureDb.initialize();
  } catch {
    await infrastructureDb.initialize({ forceFallback: true });
  }

  try { await projectManager.load(); } catch {}
  try { await configCenter.ensureLoaded(); } catch {}

  for (const domain of [...new Set(projectManager.getProjects().map(p => p.domain))]) {
    featureFlags.enable(domain);
  }

  initialized = true;
}

export default async function handler(req: any, res: any) {
  await init();
  app(req, res);
}
