import { randomUUID } from 'crypto';
import { auth } from '../auth';

/**
 * MFA support for the Tone gateway.
 *
 * TOTP factors are managed by the users project's Supabase Auth (GoTrue),
 * which stores them in its `auth` schema and owns QR/secret generation and
 * code verification. The gateway proxies the enrollment, challenge, verify,
 * unenroll and list-factors APIs to GoTrue using the user's access token.
 *
 * At sign-in, if the user has a verified factor, the gateway holds the
 * freshly issued AAL1 session in memory for a short window (keyed by a
 * random `mfa_session_id`) and refuses to release it until the frontend
 * proves the TOTP code via challenge + verify. GoTrue's verify response
 * contains the upgraded AAL2 session tokens, which are then returned to the
 * frontend. Pending sessions are never persisted and expire automatically.
 */

export interface MfaFactor {
  id: string;
  factor_type?: string;
  status?: string;
  friendly_name?: string;
  created_at?: string;
  updated_at?: string;
}

export interface MfaSession {
  access_token: string;
  refresh_token: string;
  user_id: string;
  factor_id: string;
  expires_at: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const pendingSessions = new Map<string, MfaSession>();

export function createPendingMfaSession(pending: Omit<MfaSession, 'expires_at'>): string {
  const id = randomUUID();
  pendingSessions.set(id, { ...pending, expires_at: Date.now() + PENDING_TTL_MS });
  return id;
}

export function getPendingMfaSession(id: string | undefined): MfaSession | null {
  if (!id) return null;
  const pending = pendingSessions.get(id);
  if (!pending) return null;
  if (Date.now() > pending.expires_at) {
    pendingSessions.delete(id);
    return null;
  }
  return pending;
}

export function deletePendingMfaSession(id: string): void {
  pendingSessions.delete(id);
}

interface GoTrueResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: { message: string; code?: string };
}

async function goTrueFetch<T>(
  accessToken: string,
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<GoTrueResult<T>> {
  const credentials = await auth.getProjectCredentials();
  if (!credentials) {
    return { ok: false, status: 500, data: null, error: { message: 'Auth service not configured' } };
  }

  const url = `${credentials.project_url}/auth/v1${path}`;
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: credentials.anon_key,
        Authorization: `Bearer ${accessToken}`,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (res.status === 204) {
      return { ok: true, status: 204, data: null };
    }

    const json: any = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data: null,
        error: {
          message: json?.msg || json?.message || 'MFA request failed',
          code: json?.error_code || json?.code,
        },
      };
    }
    return { ok: true, status: res.status, data: json as T };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: { message: String(error) } };
  }
}

function normalizeFactors(data: any): MfaFactor[] {
  const all = data?.all || data?.totp || [];
  if (!Array.isArray(all)) return [];
  return all.map((f: any) => ({
    id: f.id,
    factor_type: f.factor_type || f.type,
    status: f.status,
    friendly_name: f.friendly_name,
    created_at: f.created_at,
    updated_at: f.updated_at,
  }));
}

function hasVerifiedFactor(data: any): string | undefined {
  const factors = data?.all || data?.totp || [];
  if (!Array.isArray(factors)) return undefined;
  const verified = factors.find((f: any) => f.status === 'verified');
  return verified?.id as string | undefined;
}

export const mfaService = {
  async listFactors(accessToken: string): Promise<GoTrueResult<any>> {
    return goTrueFetch(accessToken, '/factors');
  },

  async enroll(
    accessToken: string,
    params: { factorType: string; friendlyName?: string; issuer?: string }
  ): Promise<GoTrueResult<any>> {
    return goTrueFetch(accessToken, '/factors', {
      method: 'POST',
      body: {
        factor_type: params.factorType,
        friendly_name: params.friendlyName,
        issuer: params.issuer,
      },
    });
  },

  async challenge(accessToken: string, factorId: string): Promise<GoTrueResult<any>> {
    return goTrueFetch(accessToken, `/factors/${factorId}/challenge`, { method: 'POST' });
  },

  async verify(
    accessToken: string,
    factorId: string,
    challengeId: string,
    code: string
  ): Promise<GoTrueResult<any>> {
    return goTrueFetch(accessToken, `/factors/${factorId}/challenge/verify`, {
      method: 'POST',
      body: { challenge_id: challengeId, code },
    });
  },

  async unenroll(accessToken: string, factorId: string): Promise<GoTrueResult<any>> {
    return goTrueFetch(accessToken, `/factors/${factorId}`, { method: 'DELETE' });
  },

  normalizeFactors,
  hasVerifiedFactor,
  createPendingMfaSession,
  getPendingMfaSession,
  deletePendingMfaSession,
};
