import { Router, Request, Response } from 'express';
import { auth, AuthUser } from '../auth';
import { rateLimiter } from '../rate-limiting';
import { mfaService, MfaFactor } from '../mfa';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && EMAIL_REGEX.test(email);
}

function validatePassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

const authRouter = Router();

async function getFactorsForToken(accessToken: string | null | undefined): Promise<MfaFactor[]> {
  if (!accessToken) return [];
  const { ok, data } = await mfaService.listFactors(accessToken);
  if (!ok) return [];
  return mfaService.normalizeFactors(data);
}

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
      // Instant registration: no email verification required.
      // GoTrue treats this as an already-confirmed user, so they can
      // sign in immediately after signing up.
      email_confirm: true,
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

    const session = data.session;
    const accessToken = session?.access_token;

    const factorsResult = accessToken ? await mfaService.listFactors(accessToken) : null;
    const factors = factorsResult ? mfaService.normalizeFactors(factorsResult.data) : [];
    const verifiedFactorId = factorsResult ? mfaService.hasVerifiedFactor(factorsResult.data) : undefined;

    // If the user has a verified MFA factor, do not release the session yet.
    // Hold the AAL1 session briefly and require the TOTP code first.
    if (verifiedFactorId && session) {
      const mfaSessionId = mfaService.createPendingMfaSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        user_id: session.user?.id || data.user?.id || '',
        factor_id: verifiedFactorId,
      });

      res.json({
        data: {
          session: null,
          mfa_required: true,
          factor_id: verifiedFactorId,
          mfa_session_id: mfaSessionId,
          factors,
        },
        error: null,
      });
      return;
    }

    res.json({
      data: {
        session: session ? { ...session, user: { ...session.user, factors } } : null,
        user: data.user,
        factors,
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

    const accessToken = auth.extractTokenFromHeader(req.headers.authorization);
    const factors = await getFactorsForToken(accessToken);

    res.json({
      data: {
        session: {
          user: { ...data.user, factors },
          access_token: accessToken,
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

    const factors = await getFactorsForToken(data.session.access_token);

    res.json({
      data: {
        session: { ...data.session, user: { ...data.session.user, factors } },
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

// ---------------------------------------------------------------------------
// MFA (TOTP) routes — proxied to the project's Supabase Auth (GoTrue)
// ---------------------------------------------------------------------------

authRouter.get('/mfa/factors', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  const token = auth.extractTokenFromHeader(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { ok, data, error, status } = await mfaService.listFactors(token);
  if (!ok) {
    res.status(status >= 500 ? 500 : 400).json({ error: error?.message || 'Failed to list MFA factors' });
    return;
  }

  res.json({ data, error: null });
});

authRouter.post('/mfa/factors', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  const token = auth.extractTokenFromHeader(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { factorType, friendlyName, issuer } = req.body || {};
  if (factorType !== 'totp') {
    res.status(400).json({ error: 'Only TOTP factors are supported' });
    return;
  }

  const { ok, data, error, status } = await mfaService.enroll(token, { factorType, friendlyName, issuer });
  if (!ok) {
    res.status(status >= 500 ? 500 : 400).json({ error: error?.message || 'Failed to enroll MFA factor' });
    return;
  }

  res.status(201).json({ data, error: null });
});

authRouter.post('/mfa/factors/:id/challenge', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { mfaSessionId } = req.body || {};

  const pending = mfaService.getPendingMfaSession(mfaSessionId);
  const token = pending ? pending.access_token : auth.extractTokenFromHeader(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { ok, data, error, status } = await mfaService.challenge(token, id);
  if (!ok) {
    res.status(status >= 500 ? 500 : 400).json({ error: error?.message || 'Failed to create MFA challenge' });
    return;
  }

  res.json({ data, error: null });
});

authRouter.post('/mfa/factors/:id/challenge/verify', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { challengeId, code, mfaSessionId } = req.body || {};

  if (!challengeId || !code) {
    res.status(400).json({ error: 'challengeId and code are required' });
    return;
  }

  const pending = mfaService.getPendingMfaSession(mfaSessionId);
  const token = pending ? pending.access_token : auth.extractTokenFromHeader(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { ok, data, error, status } = await mfaService.verify(token, id, challengeId, code);
  if (!ok) {
    if (pending) mfaService.deletePendingMfaSession(mfaSessionId);
    res.status(status >= 500 ? 500 : 400).json({ error: error?.message || 'Verification failed' });
    return;
  }

  // During sign-in the pending AAL1 session is upgraded: GoTrue's verify
  // response carries the fresh AAL2 session tokens.
  if (pending) {
    const session = {
      access_token: data?.access_token,
      refresh_token: data?.refresh_token,
      token_type: data?.token_type || 'bearer',
      expires_in: data?.expires_in,
      user: { ...(data?.user || {}), factors: await getFactorsForToken(data?.access_token) },
    };
    mfaService.deletePendingMfaSession(mfaSessionId);
    res.json({ data: { session }, error: null });
    return;
  }

  res.json({ data: { id }, error: null });
});

authRouter.delete('/mfa/factors/:id', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  const token = auth.extractTokenFromHeader(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { ok, data, error, status } = await mfaService.unenroll(token, req.params.id);
  if (!ok) {
    res.status(status >= 500 ? 500 : 400).json({ error: error?.message || 'Failed to unenroll MFA factor' });
    return;
  }

  res.json({ data: { id: req.params.id }, error: null });
});

export { authRouter };
