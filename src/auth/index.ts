import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'crypto';

const INFRA_SUPABASE_URL = process.env.INFRA_SUPABASE_URL;
const INFRA_SUPABASE_KEY = process.env.INFRA_SUPABASE_KEY;

export interface AuthUser {
  id: string;
  email?: string;
  role?: string;
}

export interface AuthCredentials {
  project_url: string;
  anon_key: string;
  service_key: string;
  jwt_secret: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// Cache credentials to avoid repeated lookups
let cachedCredentials: AuthCredentials | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getAuthCredentials(domain: string = 'users'): Promise<AuthCredentials | null> {
  if (cachedCredentials && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedCredentials;
  }

  if (!INFRA_SUPABASE_URL || !INFRA_SUPABASE_KEY) {
    console.error('[Auth] INFRA_SUPABASE_URL or INFRA_SUPABASE_KEY not configured');
    return null;
  }

  try {
    const infraClient = createClient(INFRA_SUPABASE_URL, INFRA_SUPABASE_KEY);

    const { data, error } = await infraClient
      .from('infrastructure_projects')
      .select('project_url, anon_key, service_key, jwt_secret')
      .eq('domain', domain)
      .single();

    if (error || !data) {
      console.error('[Auth] Failed to fetch credentials from infrastructure DB:', error);
      return null;
    }

    if (!data.jwt_secret) {
      console.error(`[Auth] No JWT secret configured for domain: ${domain}`);
      return null;
    }

    cachedCredentials = {
      project_url: data.project_url,
      anon_key: data.anon_key,
      service_key: data.service_key,
      jwt_secret: data.jwt_secret,
    };
    cacheTimestamp = Date.now();

    return cachedCredentials;
  } catch (error) {
    console.error('[Auth] Error fetching credentials:', error);
    return null;
  }
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
}

class AuthService {
  async authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }

    const token = authHeader.split(' ')[1];
    try {
      const user = await this.verifyToken(token);
      if (!user) {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }
      req.user = user;
      next();
    } catch (error) {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  async verifyToken(token: string): Promise<AuthUser | null> {
    try {
      const credentials = await getAuthCredentials();
      if (!credentials) {
        console.error('[Auth] No credentials available for JWT verification');
        return null;
      }

      const parts = token.split('.');
      if (parts.length !== 3) {
        console.error('[Auth] Malformed JWT: expected 3 parts, got', parts.length);
        return null;
      }

      const [headerB64, payloadB64, signatureB64] = parts;

      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

      if (header.alg !== 'HS256') {
        console.error('[Auth] Unsupported JWT algorithm:', header.alg);
        return null;
      }

      const secret = credentials.jwt_secret;
      const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
      const expectedSig = createHmac('sha256', key)
        .update(`${headerB64}.${payloadB64}`)
        .digest('base64url');

      if (!constantTimeCompare(expectedSig, signatureB64)) {
        console.error('[Auth] JWT signature mismatch');
        return null;
      }

      if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
        console.error('[Auth] JWT expired');
        return null;
      }

      return {
        id: payload.sub || '',
        email: payload.email as string | undefined,
        role: payload.role as string | undefined,
      };
    } catch (error) {
      console.error('[Auth] Token verification failed:', error);
      return null;
    }
  }

  extractTokenFromHeader(authHeader: string | undefined): string | null {
    if (!authHeader?.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.split(' ')[1];
  }

  async getSupabaseClient(): Promise<ReturnType<typeof createClient> | null> {
    const credentials = await getAuthCredentials();
    if (!credentials) return null;

    return createClient(credentials.project_url, credentials.service_key);
  }

  async getAnonClient(): Promise<ReturnType<typeof createClient> | null> {
    const credentials = await getAuthCredentials();
    if (!credentials) return null;

    return createClient(credentials.project_url, credentials.anon_key);
  }

  authenticateAdmin(req: Request, res: Response, next: NextFunction): void {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey) {
      console.error('[Auth] ADMIN_API_KEY not configured');
      res.status(503).json({ error: 'Admin access not configured' });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing admin authorization' });
      return;
    }

    const token = authHeader.split(' ')[1];
    if (!constantTimeCompare(token, adminKey)) {
      res.status(403).json({ error: 'Invalid admin credentials' });
      return;
    }

    next();
  }
}

export const auth = new AuthService();
