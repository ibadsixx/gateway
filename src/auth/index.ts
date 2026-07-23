import { Request, Response, NextFunction } from 'express';
import { jwtVerify, JWTPayload } from 'jose';

const JWT_SECRET = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET || '');

export interface AuthUser {
  id: string;
  email?: string;
  role?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
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
      if (!JWT_SECRET.length) {
        console.error('[Auth] SUPABASE_JWT_SECRET not configured');
        return null;
      }

      const { payload } = await jwtVerify(token, JWT_SECRET);
      
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
}

export const auth = new AuthService();
