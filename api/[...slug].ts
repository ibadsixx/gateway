import express from 'express';
import { router } from '../../src/api/routes';
import { middleware } from '../../src/api/middleware';
import { infrastructureDb } from '../../src/infrastructure/database/infrastructureDb';
import { projectManager } from '../../src/project-manager';
import { configCenter } from '../../src/config';
import { featureFlags } from '../../src/features';

const app = express();
middleware(app);
app.use('/api', router);

let initialized = false;
let initPromise: Promise<void> | null = null;

async function ensureInit() {
  if (initialized) return;
  if (!initPromise) {
    initPromise = (async () => {
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
    })();
  }
  await initPromise;
}

export default async function handler(req: any, res: any) {
  await ensureInit();
  app(req, res);
}
