import express from 'express';
import { router } from './api/routes';
import { middleware } from './api/middleware';
import { infrastructureDb } from './infrastructure/database/infrastructureDb';
import { projectManager } from './project-manager';
import { configCenter } from './config';
import { featureFlags } from './features';

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

      for (const domain of [...new Set(projectManager.getProjects().map((p: any) => p.domain))]) {
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
