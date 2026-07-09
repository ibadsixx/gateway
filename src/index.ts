import express from 'express';
import { router } from './api/routes';
import { middleware } from './api/middleware';

const app = express();

middleware(app);
app.use('/api', router);

export { app };
