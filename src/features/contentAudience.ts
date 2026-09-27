// The single source of truth for "what audience is this content row?".
//
// This module deliberately has NO imports so that every layer can depend on it
// without creating a cycle. Before it existed, the audience vocabulary lived in
// `reactionUsers.ts`, which imports `isGuestPostVisible` from `guestAccess.ts`.
// That made it impossible for the *guest* evaluator to use the canonical
// resolution without a `guestAccess -> reactionUsers -> guestAccess` cycle, so
// the guest path grew its own, weaker, case-sensitive copy of the rule:
//
//   // guestAccess.ts, before
//   if (visibility && visibility !== 'public') return false;
//   if (audience && audience !== 'public') return false;
//
// Two different answers to the same question, from the same row:
//
//   { audience_type: 'Public', visibility: 'public' }
//     -> isGuestPostVisible         false   (guest + crawler are DENIED)
//     -> resolveContentAudience     public  (authenticated viewer is ALLOWED)
//
// Crawlability of a public post then depended on the letter case somebody
// happened to type in the composer, which is exactly the "determine
// crawlability from the actual content audience" rule this module now enforces
// in one place. The same divergence applied to the stored aliases the composer
// has always written (`Everyone`, `All`, `Anyone`, `Only Me`, `Private`): all
// are public or private by definition, and the case-sensitive copy guessed
// wrong for all of them.

export type AudienceRow = Record<string, unknown>;

// Canonical audience for a content row. `null` means "the field carried no
// value" (so a caller may fall back to another column); `DENIED_AUDIENCE` means
// "the value was present but unrecognized" and must fail closed rather than be
// treated as public. Aliases are accepted because the same audience has been
// written as `friends`, `Friends`, `friends_only` and `friends-only` over time.
export const DENIED_AUDIENCE = 'denied';

export function canonicalAudienceType(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().toLowerCase();
  if (raw === '') return null;
  switch (raw.replace(/[\s-]+/g, '_')) {
    case 'public':
    case 'everyone':
    case 'anyone':
    case 'all':
      return 'public';
    case 'friends':
    case 'friend':
    case 'ally':
    case 'allies':
    case 'friends_only':
    case 'followers':
      return 'friends';
    case 'only_me':
    case 'onlyme':
    case 'me':
    case 'private':
    case 'restricted':
      return 'only_me';
    case 'friends_except':
      return 'friends_except';
    case 'specific':
      return 'specific';
    case 'custom_list':
      return 'custom_list';
    default:
      return DENIED_AUDIENCE;
  }
}

// `audience_type` is the canonical, RLS-authoritative column (it is what
// public.can_view_post and the `Posts are viewable based on audience and status`
// policy evaluate, and the column DEFAULT is 'public'). The legacy `visibility`
// column is NOT allowed to shadow it: the reel composer writes both columns
// with the same value, so evaluating `visibility` first rejected a
// `friends` post for every accepted friend and reduced it to owner-only. It is
// consulted only when `audience_type` carries no value at all (legacy rows
// written before the column existed), and an unrecognized value fails closed.
export function resolveContentAudience(row: AudienceRow): string {
  const declared = canonicalAudienceType(row['audience_type']);
  if (declared !== null) return declared;
  const legacy = canonicalAudienceType(row['visibility']);
  if (legacy === null) return 'public';
  return legacy;
}

// `public` is the only audience value that may be served to an unauthenticated
// caller. Everything else - `friends`, `friends_except`, `specific`,
// `custom_list`, `only_me`, `denied` - is restricted by definition, so this is
// the predicate the public sitemap and the public-content page share. Note it
// is NOT the same predicate as "an authenticated viewer can see this": a public
// post can still be withheld from a specific individual via
// `audience_excluded_user_ids`, which is a per-viewer rule and therefore cannot
// apply to a guest who has no identity.
export function isPublicAudience(row: AudienceRow): boolean {
  return resolveContentAudience(row) === 'public';
}

// The stricter guest predicate: BOTH audience columns must independently say
// public before a row is served to someone with no identity.
//
// RLS's `can_view_post` receives only `audience_type`, so for a row whose legacy
// `visibility` column DISAGREES with it, the database treats the row as public
// while the guest read path historically treated it as restricted. Keeping the
// disagreement deny-by-default is deliberate: the two columns are written by
// different composers and legacy rows exist where they drifted, and a guest has
// no identity that could be checked against the per-viewer rules. When in
// doubt an anonymous caller is refused, which is the direction the requirement
// "do not weaken existing privacy/security rules" requires. Content that is
// genuinely public has both columns in agreement and is served normally.
//
// The values are compared through the canonical normalizer, so this is not a
// case-sensitive string test: `Public`, `PUBLIC`, `Everyone` and `All` are all
// public (the old raw `!== 'public'` comparison silently un-crawlable real
// public content), and `Only Me`/`Private`/`only_me` are all restricted.
export function isGuestSafePublicAudience(row: AudienceRow): boolean {
  if (!isPublicAudience(row)) return false;
  const legacy = canonicalAudienceType(row['visibility']);
  if (legacy !== null && legacy !== 'public') return false;
  return true;
}

// Unpublished content is author-only. `status` is absent on many legacy rows, so
// only an explicit non-published value denies; an unknown status is NOT treated
// as published, because publishing is the state a row must be moved into.
export function isPublishedContent(row: AudienceRow): boolean {
  const status = row['status'];
  if (status === null || status === undefined) return true;
  return String(status).trim().toLowerCase() === 'published';
}
