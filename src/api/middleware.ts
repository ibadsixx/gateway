import { Express, json, urlencoded, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { rateLimiter } from '../rate-limiting';
import { auditLogger } from '../audit';
import { metricsService } from '../metrics';

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

export function middleware(app: Express): void {
  app.use(cors({
    origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }));
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true }));

  rateLimiter.define('*', { windowMs: 60000, maxRequests: 1000 });
  rateLimiter.define('POST /comments', { windowMs: 60000, maxRequests: 100 });
  rateLimiter.define('POST /auth/sign-up', { windowMs: 60000, maxRequests: 5 });
  rateLimiter.define('POST /auth/sign-in', { windowMs: 60000, maxRequests: 20 });

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Gateway', 'Tone-API-Gateway');
    res.setHeader('X-API-Version', 'v1');

    const key = req.ip || 'unknown';
    const routePath = req.path.replace(/^\/api\b/, '') || '/';
    const endpoint = `${req.method} ${routePath}`;
    if (!rateLimiter.check(endpoint, key)) {
      metricsService.increment('rate_limit.exceeded', { endpoint });
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    const start = Date.now();
    const originalEnd = res.end.bind(res);
    res.end = function (...args: Parameters<Response['end']>) {
      const duration = Date.now() - start;
      metricsService.record('request.duration', duration, { method: req.method, path: req.path });
      auditLogger.log({
        userId: (req as any).userId || 'anonymous',
        action: `${req.method} ${req.path}`,
        resource: req.path,
        resourceId: req.params?.id,
        ip: req.ip || '',
        duration,
        status: res.statusCode < 400 ? 'SUCCESS' : 'FAILURE',
      });
      return originalEnd(...args);
    } as Response['end'];

    next();
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[Error]', err.message);
    metricsService.increment('error.unhandled', { message: err.message });
    res.status(500).json({ error: 'Internal server error' });
  });
}
