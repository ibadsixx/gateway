import { projectManager } from './project-manager';

const sanitizeUsername = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 30);

export interface ProfileEnsureResult {
  username: string;
  displayName: string;
  /** true if a row was inserted, false if it already existed */
  created: boolean;
}

/**
 * Ensures a `profiles` row exists for the given auth user in the profiles
 * project. Idempotent (checks first), race-safe (re-reads if a concurrent
 * insert wins) and never overwrites an existing row. On a username collision
 * it falls back to a derived unique username (`user_<id[:8]>`) so the account
 * is always browsable, even when metadata usernames collide.
 */
export async function ensureUserProfile(user: {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}): Promise<ProfileEnsureResult> {
  const project = projectManager.getWritableProject('profiles');
  if (!project) {
    throw new Error('No writable project for profiles domain');
  }
  const client = project.client;

  const existing = await client
    .from('profiles')
    .select('id, username, display_name')
    .eq('id', user.id)
    .maybeSingle();
  if (existing.error) {
    throw new Error(`Profile lookup failed: ${existing.error.message}`);
  }
  if (existing.data) {
    return {
      username: existing.data.username,
      displayName: existing.data.display_name,
      created: false,
    };
  }

  const meta = user.user_metadata || {};
  const usernameRaw = typeof meta.username === 'string' ? meta.username.trim() : '';
  const displayNameRaw = typeof meta.display_name === 'string' ? meta.display_name.trim() : '';
  const emailPrefix = sanitizeUsername(user.email?.split('@')[0] ?? '');
  const desiredUsername = usernameRaw || emailPrefix || `user_${user.id.slice(0, 8)}`;
  const displayName = displayNameRaw || usernameRaw || emailPrefix || 'Tone User';

  const attemptInsert = (username: string) =>
    client
      .from('profiles')
      .insert({ id: user.id, username, display_name: displayName })
      .select('id, username, display_name')
      .maybeSingle();

  try {
    const row = await attemptInsert(desiredUsername);
    return { username: row.data?.username || desiredUsername, displayName, created: true };
  } catch (err) {
    // Likely a username collision or a concurrent insert. Fall back to a
    // derived unique username; if that fails too, another request may have
    // already created the row — re-read before surfacing the error.
    const fallbackUsername = `user_${user.id.slice(0, 8)}`;
    try {
      const row = await attemptInsert(fallbackUsername);
      return { username: row.data?.username || fallbackUsername, displayName, created: true };
    } catch {
      const after = await client
        .from('profiles')
        .select('id, username, display_name')
        .eq('id', user.id)
        .maybeSingle();
      if (after.data) {
        return {
          username: after.data.username,
          displayName: after.data.display_name,
          created: false,
        };
      }
      throw err;
    }
  }
}