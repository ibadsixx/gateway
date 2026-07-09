import 'dotenv/config';
import express from 'express';
import { router } from '../src/api/routes';
import { middleware } from '../src/api/middleware';
import { infrastructureDb } from '../src/infrastructure/database/infrastructureDb';
import { projectManager } from '../src/project-manager';
import { configCenter } from '../src/config';
import { featureFlags } from '../src/features';
import { permissionEngine } from '../src/permissions';
import { jobQueue } from '../src/jobs/queue';
import { monitoring } from '../src/infrastructure/monitoring';

const app = express();
middleware(app);
app.use('/api', router);

let initialized = false;

export default async function handler(req: any, res: any) {
  if (!initialized) {
    await infrastructureDb.initialize();
    await projectManager.load();
    await configCenter.ensureLoaded();

    const projects = projectManager.getProjects();
    const domains = [...new Set(projects.map(p => p.domain))];
    for (const domain of domains) {
      featureFlags.enable(domain);
    }

    await configCenter.set('maxUploadSize', 10485760, 'number');
    await configCenter.set('aiModerationEnabled', true, 'boolean');
    await configCenter.set('softDeleteRetentionDays', 30, 'number');

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

    if (process.env.VERCEL !== '1') {
      monitoring.start();
    }
    initialized = true;
  }

  app(req, res);
}
