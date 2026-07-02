import { Request, Response, NextFunction } from 'express';

class AuthService {
  async authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      _res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  }

  async verifyToken(token: string): Promise<{ userId: string } | null> {
    return { userId: 'user-id' };
  }
}

export const auth = new AuthService();
