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

// THE PUBLIC BOUNDARY.
//
// `audience === "public"` is the only thing that may cross the anonymous
// boundary. This predicate deliberately does NOT reuse `resolveContentAudience`,
// even though that is the right function for deciding what an AUTHENTICATED
// viewer may read. The two answer different questions and must not share code:
//
//   authenticated: "may this viewer read this row?" -> viewer + audience +
//                  relationship. A missing audience column can sensibly default
//                  to public here, because the viewer still has an identity that
//                  the per-viewer rules (ownership, friendship, exclusions) are
//                  checked against.
//
//   public/search: "may ANY anonymous caller read this row?" -> audience only.
//                  There is no identity to check, so the audience value is the
//                  entire basis for the decision, and anything that is not
//                  literally the word `public` has to fail closed.
//
// The three differences from the authenticated resolver, each of which used to
// be a way for a row to be published without anybody having chosen `public`:
//
//   1. NO DEFAULT. `resolveContentAudience` returns 'public' when both audience
//      columns are empty. A row with `audience_type = null` was therefore
//      served to every guest and listed in the sitemap. The column is
//      `text DEFAULT 'public'`, but a default only applies to an INSERT that
//      omits the column: a row can still end up NULL, and so can any row written
//      before the column existed. A NULL is not a decision, so it is not public.
//      This matches RLS, where `can_view_post` is
//      `WHEN post_audience_type = 'public' THEN true ... ELSE false` and a NULL
//      falls to ELSE false.
//
//   2. NO ALIAS WIDENING. `canonicalAudienceType` maps 'Everyone', 'Anyone' and
//      'All' onto 'public' (and 'followers' onto 'friends', etc.). Those are
//      reasonable readings when the point is to understand a row's intent, but
//      as a publish gate they mean "a value nobody has audited is treated as
//      public". The requirement is the exact value.
//
//   3. NO CASE WIDENING. 'Public' and 'PUBLIC' are not the value the column
//      documents. RLS compares literally and treats them as non-public, so the
//      Gateway treating them as public made it strictly MORE permissive than the
//      database it fronts - the opposite of the safe direction.
//
// A row that is genuinely public in the product has `audience_type = 'public'`,
// which is what the composer writes and what all 24 production rows hold. The
// cost of this strictness is therefore that a hand-edited or drifted row stops
// being indexed until someone sets it to the real value; the benefit is that no
// row is ever published by accident.
export function isPublicAudience(row: AudienceRow): boolean {
  return isExactlyPublic(row['audience_type']);
}

// The single definition of "this value says public", at the public boundary.
// A string equal to `public` after trimming surrounding whitespace - the one
// leniency, because a trailing space is a storage artifact rather than a
// different audience, and it cannot be produced by any audience picker. Case is
// NOT normalized: see note 3 above.
function isExactlyPublic(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === 'public';
}

// The guest read gate. Two independent requirements, both mandatory:
//
//   - the canonical `audience_type` column must be exactly `public`, and
//   - the legacy `visibility` column must not CONTRADICT it.
//
// The second condition is about drifted rows. The two columns are written by
// different composers, and legacy rows exist where they disagree. RLS only reads
// `audience_type`, so the database would publish a row whose `visibility` says
// `friends`. A guest has no identity against which the per-viewer rules could be
// checked, so when the two columns disagree the anonymous read is refused and
// the row is kept out of the sitemap. A `visibility` of `public`, absent, or
// empty does not contradict anything and is fine.
export function isGuestSafePublicAudience(row: AudienceRow): boolean {
  if (!isPublicAudience(row)) return false;
  const legacy = row['visibility'];
  if (legacy === null || legacy === undefined) return true;
  return isExactlyPublic(legacy);
}

// Unpublished content is author-only. `status` is absent on many legacy rows, so
// only an explicit non-published value denies; an unknown status is NOT treated
// as published, because publishing is the state a row must be moved into.
export function isPublishedContent(row: AudienceRow): boolean {
  const status = row['status'];
  if (status === null || status === undefined) return true;
  return String(status).trim().toLowerCase() === 'published';
}

// The one predicate every public/anonymous surface must go through: a guest
// read, a single-row `/post/:id` read, the profile content page, Explore, the
// public sitemap, and the content page's own indexing signals. Each of those
// already funnels into either `canViewerViewPost` (which delegates here for a
// guest) or this module directly, so there is a single place to audit and a
// single place to change if the rule ever moves.
export function isGuestSafePublicContent(row: AudienceRow): boolean {
  if (!row || typeof row !== 'object') return false;
  return isPublishedContent(row) && isGuestSafePublicAudience(row);
}
