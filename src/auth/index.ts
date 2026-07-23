import { Request, Response, NextFunction } from 'express';
import { jwtVerify, JWTPayload } from 'jose';
import { createClient } from '@supabase/supabase-js';

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
  // Return cached credentials if fresh
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

      const jwtSecret = new TextEncoder().encode(credentials.jwt_secret);
      const { payload } = await jwtVerify(token, jwtSecret);
      
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
}

export const auth = new AuthService();
