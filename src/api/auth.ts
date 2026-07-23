import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { auth, AuthUser } from '../auth';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.INFRA_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.INFRA_SUPABASE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const supabaseAdmin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);

const authRouter = Router();

// Sign up
authRouter.post('/sign-up', async (req: Request, res: Response) => {
  try {
    const { email, password, options } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: options?.data || {},
    });

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    // Generate tokens for the new user
    const { data: tokens, error: tokenError } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });

    if (tokenError) {
      res.status(201).json({ 
        data: { user: data.user, session: null },
        error: null 
      });
      return;
    }

    res.status(201).json({
      data: {
        user: data.user,
        session: {
          access_token: tokens.properties?.action_link?.split('token=')[1] || '',
          refresh_token: '',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'bearer',
          user: data.user,
        },
      },
      error: null,
    });
  } catch (error) {
    console.error('[Auth] Sign-up error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sign in
authRouter.post('/sign-in', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
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

// Sign out
authRouter.post('/sign-out', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  try {
    const token = auth.extractTokenFromHeader(req.headers.authorization);
    if (token) {
      // Revoke the refresh token
      await supabaseAdmin.auth.admin.signOut(token);
    }
    res.json({ error: null });
  } catch (error) {
    console.error('[Auth] Sign-out error:', error);
    res.json({ error: null }); // Sign out always succeeds
  }
});

// Get session
authRouter.get('/session', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Get fresh user data from Supabase
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(user.id);

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

// Refresh session
authRouter.post('/refresh', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Generate a new session for the user
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email || '',
    });

    if (error) {
      res.status(500).json({ error: 'Failed to refresh session' });
      return;
    }

    // Get fresh user data
    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(user.id);

    res.json({
      data: {
        session: {
          user: userData?.user || { id: user.id, email: user.email },
          access_token: data.properties?.action_link?.split('token=')[1] || auth.extractTokenFromHeader(req.headers.authorization),
          refresh_token: '',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'bearer',
        },
      },
      error: null,
    });
  } catch (error) {
    console.error('[Auth] Refresh error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user
authRouter.put('/user', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(
      user.id,
      { user_metadata: req.body }
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
