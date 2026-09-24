// Aggregate reaction counts for a post (do.md "Guest users — reaction
// visibility" round).
//
// An unauthenticated guest viewing a PUBLIC post must see whether the post has
// reactions and the total reaction count (plus the summary icons the app
// already renders), while never seeing WHO reacted and never being able to
// react. The `reactions` table's rows carry reactor identities, so guests are
// denied the list read (`reactions` is not a guest-readable domain — the 403
// at the route boundary keeps reactor identities private). Instead this module
// computes the aggregate counts server-side, INDEPENDENT of any (empty-for-
// guests) filtered list, on the hosts that actually own the `reactions`
// table (a different Supabase project than `posts`).
//
// Only the aggregate numbers leave this module — never the reaction rows — so
// reactor identities are never exposed. Guest mutation remains impossible at
// the route layer (POST /:domain and every /api/v1 route require
// authentication).

/** Counts of raw DB `reaction_type` values, keyed by type. */
export interface ReactionTypeMap {
  [type: string]: number;
}

export interface ReactionCounts {
  reaction_count: number;
  reaction_types: ReactionTypeMap;
}

/** The subset of the supabase client a reaction-count query needs. */
export interface CountClient {
  from(table: string): unknown;
}

/** Projects hosting the `reactions` table. */
export interface CountProjects {
  client: CountClient;
}

/** Group raw reaction rows (only the `type` column) into per-type totals. */
export function groupReactionTypes(rows: Array<{ type?: string }>): ReactionTypeMap {
  const map: ReactionTypeMap = {};
  for (const row of rows) {
    const type = row && typeof row === 'object' ? (row as { type?: string })['type'] : undefined;
    if (!type) continue;
    map[type] = (map[type] || 0) + 1;
  }
  return map;
}

/** Merge per-type totals from several hosts. */
export function mergeReactionTypes(maps: ReactionTypeMap[]): ReactionTypeMap {
  const merged: ReactionTypeMap = {};
  for (const map of maps) {
    for (const [type, count] of Object.entries(map)) {
      merged[type] = (merged[type] || 0) + count;
    }
  }
  return merged;
}

/**
 * Fetch a post's aggregate reaction counts across every readable `reactions`
 * project. Only the `type` column is selected (never `user_id`), so no reactor
 * identity is read or exposed. A host that doesn't serve the table (throws) or
 * reports an error is skipped, so a `reactions` table split across projects
 * still yields the true totals.
 */
export async function getReactionCounts(projects: CountProjects[], postId: string): Promise<ReactionCounts> {
  const reaction_types = mergeReactionTypes(await Promise.all(projects.map((entry) => _fetchOne(entry, postId))));
  const reaction_count = Object.values(reaction_types).reduce((sum, count) => sum + count, 0);
  return { reaction_count, reaction_types };
}

async function _fetchOne(entry: CountProjects, postId: string): Promise<ReactionTypeMap> {
  try {
    const chain: any = entry.client.from('reactions');
    const result = await chain.select('type').eq('post_id', postId);
    if (result?.error) return {};
    const rows: Array<{ type?: string }> = Array.isArray(result?.data) ? result.data : [];
    return groupReactionTypes(rows);
  } catch {
    return {};
  }
}