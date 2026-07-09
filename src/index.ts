import 'dotenv/config';
import express from 'express';
import { router } from './api/routes';
import { middleware } from './api/middleware';
import { monitoring } from './infrastructure/monitoring';
import { featureFlags } from './features';
import { configCenter } from './config';
import { permissionEngine } from './permissions';
import { infrastructureDb } from './infrastructure/database/infrastructureDb';
import { jobQueue } from './jobs/queue';
import { projectManager } from './project-manager';

const app = express();
const PORT = process.env.PORT || 3000;

middleware(app);
app.use('/api', router);

async function initializeDefaults(): Promise<void> {
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
  permissionEngine.definePolicy('user', ['posts:create', 'posts:read', 'posts:update', 'posts:delete',
    'comments:create', 'comments:read',
    'media:upload', 'media:read']);

  jobQueue.register('media.process', async (job) => {
    console.log(`Processing media job: ${job.id}`, job.payload);
  });

  jobQueue.register('notification.send', async (job) => {
    console.log(`Sending notification: ${job.id}`, job.payload);
  });

  monitoring.start();

  setInterval(() => {
    projectManager.refreshRegistry().catch(err =>
      console.error('[Cache] Periodic registry refresh failed:', err),
    );
  }, 60000);

  console.log('Tone API Gateway initialized with all services');
}

if (process.env.VERCEL !== '1') {
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
}

export default app;
