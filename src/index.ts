import 'dotenv/config';
import express from 'express';
import { router } from './api/routes';
import { middleware } from './api/middleware';
import { monitoring } from './infrastructure/monitoring';
import { featureFlags } from './features';
import { configCenter } from './config';
import { permissionEngine } from './permissions';
import { eventBus } from './events/bus';
import { jobQueue } from './jobs/queue';
import { searchService } from './search';
import { infrastructureDb } from './infrastructure/database/infrastructureDb';

const app = express();
const PORT = process.env.PORT || 3000;

middleware(app);
app.use('/api', router);

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

async function initializeDefaults(): Promise<void> {
  await infrastructureDb.initialize();
  await configCenter.ensureLoaded();

  featureFlags.enable('posts');
  featureFlags.enable('comments');
  featureFlags.enable('stories');
  featureFlags.enable('users');
  featureFlags.enable('conversations');
  featureFlags.enable('groups');
  featureFlags.enable('pages');
  featureFlags.enable('reports');
  featureFlags.enable('media');
  featureFlags.enable('notifications');
  featureFlags.enable('blocking');

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

  eventBus.on('post.created', async (event) => {
    jobQueue.enqueue('notification.send', {
      userId: event.payload.id as string,
      title: 'Post Created',
      body: 'Your post has been published',
    });
    await searchService.index('posts', event.payload.id as string, event.payload.data as Record<string, unknown>);
  });

  monitoring.start();

  console.log('Tone API Gateway initialized with all services');
}

export default app;
