import { Request, Response, NextFunction } from 'express';

function validateRequest(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'POST' || req.method === 'PUT') {
    if (!req.body || Object.keys(req.body).length === 0) {
      res.status(400).json({ error: 'Request body is required' });
      return;
    }
  }
  next();
}

const allowedDomains = new Set([
  'users', 'posts', 'comments', 'stories',
  'conversations', 'groups', 'pages', 'reports',
  'media', 'notifications',
]);

function validateDomain(domain: string): boolean {
  return allowedDomains.has(domain);
}

function validateDomainMiddleware(req: Request, res: Response, next: NextFunction): void {
  const { domain } = req.params;
  if (!validateDomain(domain)) {
    res.status(400).json({ error: `Unknown domain: ${domain}` });
    return;
  }
  next();
}

export const validation = { validateRequest, validateDomain, validateDomainMiddleware };
