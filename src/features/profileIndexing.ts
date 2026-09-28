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
//     .checked={profileIndexingSwitchOn(privacySettings)}   (src/lib/profileIndexing.ts)
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
// A side effect of the key/value shape worth stating: a row's ABSENCE is the
// default. There is no column DEFAULT that could express "ON", because the table
// holds unrelated settings and the value is only meaningful per setting_name. So
// this module, the app's mirror of it in src/lib/profileIndexing.ts, and the
// Privacy Checkup switch all have to agree on how to read an absent row, and
// there are exactly three places that do. That is also why the setting is already
// default-ON elsewhere in the codebase - hashtag notifications use the same
// absent-row-means-enabled convention in the trigger that inserts notifications.
//
// WHY THERE IS NO MIGRATION, because do.md asks for one conditionally and the
// condition turns out not to be met. Each of the following was checked against
// the real schema rather than assumed:
//
//   1. No column default exists, and none would be reachable. `setting_value` is
//      `TEXT NOT NULL` with no DEFAULT, and the table is shared by every privacy
//      setting, so `DEFAULT 'true'` could not mean "ON" for this key alone - it
//      would silently apply 'true' to any OTHER setting inserted without an
//      explicit value, replacing a NOT NULL violation with a wrong answer. It
//      would also be dead code: the single writer is `upsertPrivacySetting`, which
//      always passes the value, so no insert omits the column and the default
//      would never fire. do.md's "if appropriate for the existing schema" is
//      therefore not appropriate here.
//
//   2. There is no NULL to backfill. The spec's "NULL/unconfigured -> set to
//      TRUE" describes a nullable field, but `setting_value` is NOT NULL - the
//      unconfigured state is a MISSING ROW, which is not a row and so cannot be
//      the target of an UPDATE. The migration it describes has nothing to act on.
//
//   3. A backfill would destroy the very distinction the spec protects. do.md
//      warns against "blindly updating every existing row to TRUE" because that
//      overwrites explicit OFF. The narrower INSERT-the-missing-rows version
//      avoids that specific harm, but converts a live default into recorded data
//      for every legacy user, after which a future change to the default would
//      silently not apply to them. The app-side rule already delivers the
//      required semantics (absent -> ON) with no write at all, so a backfill buys
//      no behaviour and costs the default's flexibility.
//
// This is the one place where a literal reading of the spec's migration clause and
// the correct answer diverge, so it is spelled out here rather than left for a
// reader to infer from the absence of a migration file. Nothing in the database
// had to change, and no second setting was created.
//
// DEFAULT-ON, and that is a product decision, not an oversight. do.md
// "Important Correction - Search Engine Discovery Must Default to ON" states it
// directly: a user who has never been asked, and a user who has never answered,
// are both to be treated as permitting external indexing. The previous revision
// of this file read the same column the other way round, on the reasoning that
// the Privacy Checkup toggle rendered as `=== 'true'` and therefore already
// displayed OFF for an absent row. That reasoning is now inverted, and the toggle
// was inverted with it (see PrivacyCheckup.tsx) - changing only this module would
// have left the switch and the crawler disagreeing about the same user, which is
// the one outcome this module exists to prevent. So:
//
//   absent row        -> indexable        (the default)
//   'true'            -> indexable
//   'false'           -> NOT indexable    (the only value that withholds)
//   anything else     -> indexable
//
// The asymmetry is now reversed, and the reversal is exactly as deliberate. A
// user who said 'false' and gets indexed anyway has been published against their
// explicit instruction and cannot see it happen; a user who never chose and is
// not indexed has lost discoverability they never had to ask for. The second is
// recoverable by flipping one switch, and it is the one the product has decided
// not to impose by default.
//
// Note what the default does NOT cover, because this is the part that is easy to
// get wrong: an unrecognised value is drift, a partial write, or a client that
// is not the Privacy Checkup - and it resolves to the DEFAULT, i.e. indexable.
// The reason is that 'false' is the only value a user can produce by choosing
// not to be found, and it is the only value that must ever withhold. A garbage
// value is not a person declining to be indexed, so guessing 'not indexable' for
// it would be inventing a refusal nobody expressed - and it would make a single
// corrupt row silently de-list that user, which is the same invisible failure
// this round is removing. The tolerant reading here is the safer one *because*
// the default is permissive: the only harm a lenient parse can do is fail to
// honour a 'false' that was not literally 'false', and a literal 'false' - the
// only thing the switch writes - is always honoured.
import { projectManager } from '../project-manager';

// The setting key and the two values the Privacy Checkup switch writes. These
// must stay equal to the literals in PrivacyCheckup.tsx and in the sitemap's
// profile predicate; all three read the same column, and a rename on one side
// would silently change what every profile resolves to. `PROFILE_INDEXING_OFF`
// is now the load-bearing one: it is the single value that withholds a profile,
// so it is the thing that must never drift.
export const PROFILE_INDEXING_SETTING = 'search_engine_indexing';
export const PROFILE_INDEXING_OPT_IN = 'true';
export const PROFILE_INDEXING_OPT_OUT = 'false';

// The effective value, given whatever is in the column.
//
// DEFAULT-ON. This is the whole of the rule required by do.md:
//
//   NULL / missing -> ON
//   'true'         -> ON
//   'false'        -> OFF
//
// Named for what it answers rather than how it decides, because the old name
// (`isSearchEngineIndexingOptIn`) encoded the previous default and would now be
// actively misleading: it returns true for an absent row, which is the opposite
// of an opt-in. Every caller reads this, so a rename here is a rename of the
// product rule, not a refactor.
//
// The comparison stays exact on the OFF side. The only writer is
// `c.toString()` on a boolean switch, so the column holds 'true' or 'false' and
// nothing else, and `=== 'false'` cannot be satisfied by `'False'`, `'0'` or a
// JSON boolean. That is the conservative direction for the one value that
// withholds: a malformed write leaves the profile at the default rather than
// silently de-listing it.
export function isSearchEngineIndexingEnabled(settingValue: unknown): boolean {
  return settingValue !== PROFILE_INDEXING_OPT_OUT;
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
// sitemapSource.profileOptOutDomain: prefer the dedicated domain when the live
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
  /** False when no profile carries this username. */
  found: boolean;
  /**
   * The effective value: whether this profile may be indexed.
   *
   * True for the default (no stored preference) and for an explicit 'true'. False
   * only where somebody actually withheld it - an explicit 'false', or a
   * preference that could not be read.
   */
  enabled: boolean;
}

// The read is THREE-state, not two, and the third state is the whole point of
// this change.
//
// The old default was OFF, so "we could not read the preference" and "the user
// has no preference" collapsed into the same answer and the endpoint could get
// away with returning a plain `unknown`. Flipping the default separates them: a
// missing row now means ON, so a *failed read* that also resolved to the default
// would publish a user who explicitly set 'false' - the precise outcome do.md
// forbids when it says the explicit OFF must always take precedence. So a read
// that fails is reported as its own state and resolves to OFF, and only a
// genuinely absent row resolves to the default.
export type IndexingRead =
  | { kind: 'value'; value: unknown }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

export interface ProfileIndexingDeps {
  findProfileIdsByUsername(username: string): Promise<string[]>;
  readIndexingSetting(userIds: string[]): Promise<IndexingRead>;
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
    if (userIds.length === 0) return { kind: 'absent' } as const;
    const projects = readableProjects(privacySettingsDomain());
    // No readable project at all is a deployment that cannot answer, not a user
    // with no answer. Under a default-ON rule those two must not collapse.
    if (projects.length === 0) return { kind: 'unreadable' } as const;
    let failed = false;
    for (const project of projects) {
      const { data, error } = await project.client
        .from('privacy_settings')
        .select('setting_value')
        .eq('setting_name', PROFILE_INDEXING_SETTING)
        .in('user_id', userIds)
        .limit(1);
      // Remembered rather than skipped: a shard that errored is a shard we do
      // not know the answer for, and "the other shard had no row" is not the
      // same statement.
      if (error) {
        failed = true;
        continue;
      }
      const rows = (data ?? []) as Array<{ setting_value?: unknown }>;
      if (rows.length > 0) return { kind: 'value', value: rows[0].setting_value } as const;
    }
    // Every shard was readable and none held the row: genuinely no preference
    // stored, which is the case the new default is actually about.
    return failed ? ({ kind: 'unreadable' } as const) : ({ kind: 'absent' } as const);
  },
};

// Resolves the owner's answer for one username.
//
// Three outcomes, per IndexingRead above. The `found` flag is reported
// separately so the route can still answer 404 for a username that genuinely
// does not exist - that distinction is unrelated to indexing and is worth
// keeping, since collapsing the two would hide a real user behind a 404.
export async function readProfileIndexing(
  username: string,
  deps: ProfileIndexingDeps = defaultDeps
): Promise<ProfileIndexingResult> {
  if (!isValidProfileUsername(username)) return { found: false, enabled: false };
  let ids: string[];
  try {
    ids = await deps.findProfileIdsByUsername(username);
  } catch {
    // The profile read itself failed. `found` is genuinely unknown, and
    // answering 200 here would let an unauthenticated caller use a database
    // outage as a username oracle. 404 is the honest answer and matches what a
    // non-existent username already returns.
    return { found: false, enabled: false };
  }
  if (ids.length === 0) return { found: false, enabled: false };
  try {
    const read = await deps.readIndexingSetting(ids);
    if (read.kind === 'unreadable') return { found: true, enabled: false };
    // 'absent' deliberately falls through to the same call as 'true': that is
    // the default, expressed in one place.
    return {
      found: true,
      enabled: isSearchEngineIndexingEnabled(read.kind === 'value' ? read.value : null),
    };
  } catch {
    return { found: true, enabled: false };
  }
}
