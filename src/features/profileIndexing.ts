// The "Permit search engines beyond Tone to reference your profile?" control.
//
// do.md "Fix Privacy Checkup - Search Engine Profile Indexing". This is NOT a
// new setting. The value already exists end to end; the audit found that nothing
// downstream of the database ever read it, so the preference a user expressed was
// stored, displayed, and then ignored by every surface that could have honoured
// it. This module is the one place that reads it, so the profile page and the
// sitemap cannot disagree about the same user's answer.
//
// THE EXISTING FIELD (traced, not guessed):
//
//   Privacy Checkup UI   src/components/PrivacyCheckup.tsx
//     .checked={privacySettings.search_engine_indexing === 'true'}
//     .onCheckedChange={c => updatePrivacySetting('search_engine_indexing', c.toString())}
//     -> usersApi.upsertPrivacySetting            (src/api/users.ts)
//     -> gateway.from('privacy_settings').upsert({ user_id, setting_name, setting_value })
//     -> privacy_settings.setting_name  = 'search_engine_indexing'
//     -> privacy_settings.setting_value = 'true' | 'false'   (TEXT, not BOOLEAN)
//
// There is no boolean column and no dedicated profile flag. `privacy_settings` is
// a key/value table (user_id, setting_name, setting_value, UNIQUE(user_id,
// setting_name)) whose user_id references auth.users, NOT profiles.id - so there
// is no foreign key to join on and no way to embed it in a profile select. That
// is exactly why this needs its own read rather than a column on the profile.
//
// FAIL-CLOSED, and it has to be. The setting is opt-IN everywhere it is
// expressed: PrivacyCheckup renders the toggle as
// `=== 'true'`, so a user with no row for it is shown the switch OFF, and the
// product's own answer to "is this profile indexable?" is "no". Treating an
// absent row as consent would advertise, to Google, a profile whose owner never
// answered the question - and the user who is harmed by that cannot see the harm,
// because the switch on their own screen already reads OFF. So:
//
//   absent row        -> not indexable
//   'false'           -> not indexable
//   'true'            -> indexable
//   anything else     -> not indexable
//
// An unrecognised value is a drift or a partial write, and it is refused rather
// than guessed at. The asymmetry is deliberate and is the whole safety argument:
// a user who opted in and is not indexed loses traffic, which they can fix; a
// user who did not opt in and is indexed has been published without consent,
// which they cannot fix.
import { projectManager } from '../project-manager';

// The setting key and the single value that counts as consent. These must stay
// equal to the literals in PrivacyCheckup.tsx and in the sitemap's profile
// predicate; all three read the same column, and a rename on one side would
// silently make every profile unindexable (fail-closed) or, worse, every profile
// indexable if a default were ever flipped.
export const PROFILE_INDEXING_SETTING = 'search_engine_indexing';
export const PROFILE_INDEXING_OPT_IN = 'true';

// The exact, fail-closed test for consent.
//
// Exact, not case-insensitive and not truthy: the only writer is
// `c.toString()` on a boolean switch, so the column holds 'true' or 'false' and
// nothing else. A comparison that widened here would widen silently, and the
// failure mode is publishing a profile that said no.
export function isSearchEngineIndexingOptIn(settingValue: unknown): boolean {
  return settingValue === PROFILE_INDEXING_OPT_IN;
}

// The app's own username convention. Matched by the mention parser
// (useMentions.ts) and by the hashtag/profile link renderer
// (MentionHashtagText.tsx), which both accept `\w+` - i.e. [A-Za-z0-9_] - and
// nothing else. Validating the input against the same set the app can produce
// means this endpoint cannot be used to probe arbitrary column values, and that a
// username which renders as a link is a username this will accept.
//
// Dots are excluded deliberately: `\w` excludes them, so no username the app can
// link to contains one.
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

export function isValidProfileUsername(value: unknown): boolean {
  return typeof value === 'string' && USERNAME_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

interface ProfileIndexingProject {
  client: { from(table: string): any };
}

function readableProjects(domain: string): ProfileIndexingProject[] {
  // A read of the already-loaded project cache, not a routing query, so this
  // costs no extra round trip - the same note as sitemapSource.readableProjects.
  return projectManager.getReadableProjects(domain) as ProfileIndexingProject[];
}

// Same resolution order as peopleYouMayKnow.readableDomain and
// sitemapSource.profileOptInDomain: prefer the dedicated domain when the live
// infra registers it, else the `users` host, which owns these tables in the
// offline fallback topology. A domain that is not registered yields no projects,
// which is not an error - it just means there is nothing to read there.
function profileDomain(): string {
  return readableProjects('profiles').length > 0 ? 'profiles' : 'users';
}

function privacySettingsDomain(): string {
  return readableProjects('privacy_settings').length > 0 ? 'privacy_settings' : 'users';
}

export interface ProfileIndexingResult {
  /** False when no profile carries this username. Absent is NOT consent. */
  found: boolean;
  /** True only on an explicit 'true' row. False for absent, false, or garbage. */
  optIn: boolean;
}

export interface ProfileIndexingDeps {
  findProfileIdsByUsername(username: string): Promise<string[]>;
  readIndexingSetting(userIds: string[]): Promise<unknown>;
}

export const defaultDeps: ProfileIndexingDeps = {
  // One row: username is unique, and the id is the only thing needed.
  async findProfileIdsByUsername(username) {
    const projects = readableProjects(profileDomain());
    const ids: string[] = [];
    for (const project of projects) {
      const { data, error } = await project.client
        .from('profiles')
        .select('id')
        .eq('username', username)
        .limit(1);
      if (error) continue;
      for (const row of (data ?? []) as Array<{ id?: unknown }>) {
        if (typeof row.id === 'string' && row.id) ids.push(row.id);
      }
    }
    return ids;
  },

  // Only the setting row for this user, and only the two columns the decision
  // needs. No other privacy setting is ever selected, so this endpoint cannot be
  // used to read somebody else's privacy configuration.
  async readIndexingSetting(userIds) {
    if (userIds.length === 0) return undefined;
    const projects = readableProjects(privacySettingsDomain());
    for (const project of projects) {
      const { data, error } = await project.client
        .from('privacy_settings')
        .select('setting_value')
        .eq('setting_name', PROFILE_INDEXING_SETTING)
        .in('user_id', userIds)
        .limit(1);
      if (error) continue;
      const rows = (data ?? []) as Array<{ setting_value?: unknown }>;
      if (rows.length > 0) return rows[0].setting_value;
    }
    // No readable project, or no row: no consent. Undefined is not 'true'.
    return undefined;
  },
};

// Resolves the owner's answer for one username.
//
// Every failure resolves to "not indexable" rather than throwing, because the
// caller is a crawler directive and the safe answer to "I could not determine
// this" is "do not index". The `found` flag is reported separately so the route
// can still answer 404 for a username that genuinely does not exist.
export async function readProfileIndexingOptIn(
  username: string,
  deps: ProfileIndexingDeps = defaultDeps
): Promise<ProfileIndexingResult> {
  if (!isValidProfileUsername(username)) return { found: false, optIn: false };
  try {
    const ids = await deps.findProfileIdsByUsername(username);
    if (ids.length === 0) return { found: false, optIn: false };
    const value = await deps.readIndexingSetting(ids);
    return { found: true, optIn: isSearchEngineIndexingOptIn(value) };
  } catch {
    return { found: true, optIn: false };
  }
}
