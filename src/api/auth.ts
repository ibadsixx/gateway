import { Router, Request, Response } from 'express';
import { auth, AuthUser } from '../auth';
import { rateLimiter } from '../rate-limiting';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && EMAIL_REGEX.test(email);
}

function validatePassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

const authRouter = Router();

authRouter.post('/sign-up', async (req: Request, res: Response) => {
  try {
    const { email, password, options } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    if (!validateEmail(email)) {
      res.status(400).json({ error: 'Invalid email format' });
      return;
    }

    if (!validatePassword(password)) {
      res.status(400).json({ error: 'Password must be between 8 and 128 characters' });
      return;
    }

    const supabase = await auth.getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: 'Auth service not configured' });
      return;
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      user_metadata: options?.data || {},
    });

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    res.status(201).json({
      data: {
        user: data.user,
        session: null,
      },
      error: null,
    });
  } catch (error) {
    console.error('[Auth] Sign-up error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.post('/sign-in', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    if (!validateEmail(email)) {
      res.status(400).json({ error: 'Invalid email format' });
      return;
    }

    const supabase = await auth.getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: 'Auth service not configured' });
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      res.status(401).json({ error: error.message });
      return;
    }

    res.json({
      data: {
        session: data.session,
        user: data.user,
      },
      error: null,
    });
  } catch (error) {
    console.error('[Auth] Sign-in error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.post('/sign-out', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  try {
    const token = auth.extractTokenFromHeader(req.headers.authorization);
    if (token) {
      const supabase = await auth.getSupabaseClient();
      if (supabase) {
        await supabase.auth.admin.signOut(token);
      }
    }
    res.json({ error: null });
  } catch (error) {
    console.error('[Auth] Sign-out error:', error);
    res.json({ error: null });
  }
});

authRouter.get('/session', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const supabase = await auth.getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: 'Auth service not configured' });
      return;
    }

    const { data, error } = await supabase.auth.admin.getUserById(user.id);

    if (error) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      data: {
        session: {
          user: data.user,
          access_token: auth.extractTokenFromHeader(req.headers.authorization),
          token_type: 'bearer',
        },
      },
      error: null,
    });
  } catch (error) {
    console.error('[Auth] Get session error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token || typeof refresh_token !== 'string') {
      res.status(400).json({ error: 'refresh_token is required' });
      return;
    }

    const supabase = await auth.getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: 'Auth service not configured' });
      return;
    }

    const { data, error } = await supabase.auth.refreshSession({ refresh_token });

    if (error || !data.session) {
      res.status(401).json({ error: error?.message || 'Invalid refresh token' });
      return;
    }

    res.json({
      data: {
        session: data.session,
        user: data.user,
      },
      error: null,
    });
  } catch (error) {
    console.error('[Auth] Refresh error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const ALLOWED_METADATA_KEYS = new Set([
  'display_name', 'avatar_url', 'bio', 'location', 'website',
]);

authRouter.put('/user', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({ error: 'Request body is required' });
      return;
    }

    const sanitizedMetadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(req.body)) {
      if (ALLOWED_METADATA_KEYS.has(key)) {
        sanitizedMetadata[key] = typeof value === 'string' ? value.slice(0, 500) : value;
      }
    }

    const supabase = await auth.getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: 'Auth service not configured' });
      return;
    }

    const { data, error } = await supabase.auth.admin.updateUserById(
      user.id,
      { user_metadata: sanitizedMetadata }
    );

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    res.json({
      data: { user: data.user },
      error: null,
    });
  } catch (error) {
    console.error('[Auth] Update user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { authRouter };
