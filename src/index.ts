import 'dotenv/config';
import express from 'express';
import { router } from './api/routes';
import { middleware } from './api/middleware';
import { monitoring } from './infrastructure/monitoring';
import { featureFlags } from './features';
import { configCenter } from './config';
import { databaseRegistry } from './registry/databaseRegistry';
import { storageRegistry } from './registry/storageRegistry';
import { permissionEngine } from './permissions';
import { eventBus } from './events/bus';
import { jobQueue } from './jobs/queue';
import { auth } from './auth';
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

  await databaseRegistry.register({
    id: 'posts-1',
    domain: 'posts',
    provider: 'supabase',
    status: 'ACTIVE',
    priority: 1,
    capacity: 1000000000,
    usedSpace: 500000000,
    connectionName: 'supabase_posts_1',
    loadWeight: 50,
  });

  await databaseRegistry.register({
    id: 'posts-2',
    domain: 'posts',
    provider: 'supabase',
    status: 'ACTIVE',
    priority: 2,
    capacity: 1000000000,
    usedSpace: 100000000,
    connectionName: 'supabase_posts_2',
    loadWeight: 30,
  });

  await databaseRegistry.register({
    id: 'posts-3',
    domain: 'posts',
    provider: 'supabase',
    status: 'ACTIVE',
    priority: 3,
    capacity: 1000000000,
    usedSpace: 10000000,
    connectionName: 'supabase_posts_3',
    loadWeight: 20,
  });

  await databaseRegistry.register({
    id: 'comments-1',
    domain: 'comments',
    provider: 'supabase',
    status: 'ACTIVE',
    priority: 1,
    capacity: 500000000,
    usedSpace: 200000000,
    connectionName: 'supabase_comments_1',
    loadWeight: 50,
  });

  await databaseRegistry.register({
    id: 'comments-2',
    domain: 'comments',
    provider: 'supabase',
    status: 'ACTIVE',
    priority: 2,
    capacity: 500000000,
    usedSpace: 50000000,
    connectionName: 'supabase_comments_2',
    loadWeight: 30,
  });

  await databaseRegistry.register({
    id: 'comments-3',
    domain: 'comments',
    provider: 'supabase',
    status: 'ACTIVE',
    priority: 3,
    capacity: 500000000,
    usedSpace: 10000000,
    connectionName: 'supabase_comments_3',
    loadWeight: 20,
  });

  await databaseRegistry.register({
    id: 'stories-1',
    domain: 'stories',
    provider: 'supabase',
    status: 'ACTIVE',
    priority: 1,
    capacity: 300000000,
    usedSpace: 150000000,
    connectionName: 'supabase_stories_1',
  });

  await databaseRegistry.register({
    id: 'conversations-1',
    domain: 'conversations',
    provider: 'supabase',
    status: 'ACTIVE',
    priority: 1,
    capacity: 500000000,
    usedSpace: 0,
    connectionName: 'sbp_f34579f61778d8ab2a7f46d0800a6654a7cea67f',
    loadWeight: 100,
  });

  await storageRegistry.register({
    id: 'cloudinary-1',
    provider: 'cloudinary',
    status: 'ACTIVE',
    capacity: 10000000000,
    usedSpace: 9500000000,
    priority: 1,
  });

  await storageRegistry.register({
    id: 'cloudinary-2',
    provider: 'cloudinary',
    status: 'ACTIVE',
    capacity: 10000000000,
    usedSpace: 1000000000,
    priority: 2,
  });

  await storageRegistry.register({
    id: 's3-main',
    provider: 's3',
    status: 'ACTIVE',
    capacity: 50000000000,
    usedSpace: 5000000000,
    priority: 3,
  });

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
