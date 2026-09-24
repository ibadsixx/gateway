// Aggregate relationship counts (friends / following / followers).
//
// do.md: a hidden Friends list hides the identities of the friends, NOT the
// total number of friends. The friends/following/followers COUNT is public
// profile metadata and must be returned even when the underlying list is not
// accessible to the viewer (owner, friend, non-friend and guest alike). Only
// the aggregate number is ever exposed here — never the individual friendship
// or follower rows — so the existing list-visibility rules are untouched.
//
// Counts are computed on the hosts that actually own the tables. `friends`
// and `followers` live on different Supabase projects than `profiles`, so the
// counting queries must fan out across every readable project of the relevant
// domain (the tables may even be split across projects; each project counts
// its own slice and the results are summed). The count is deliberately
// independent of any row-level privacy filter: the whole point is that it is
// NOT derived from the visible list (do.md forbids `visibleFriends.length`).

/** The subset of the supabase client a count query needs. */
export interface CountClient {
  from(table: string): unknown;
}

/** Result of a PostgREST head-count select. */
export interface CountQueryResult {
  count: number | null;
  data: unknown[];
  error: unknown;
}

export interface RelationshipCounts {
  friends_count: number;
  following_count: number;
  followers_count: number;
}

/** Projects hosting a domain — the subset the count queries need. */
export interface CountProjects {
  client: CountClient;
}

export type CountQueryBuilder = (client: CountClient) => Promise<CountQueryResult>;

/**
 * Run a head-count query against every readable project hosting `domain` and
 * sum the results. A project that does not actually serve the table (query
 * throws or reports an error) is skipped, so a domain split across projects
 * still yields the true total.
 */
export async function sumHeadCounts(
  projects: CountProjects[],
  build: CountQueryBuilder
): Promise<number> {
  let total = 0;
  await Promise.all(
    projects.map(async (entry) => {
      try {
        const { count, error } = await build(entry.client);
        if (!error && typeof count === 'number' && count > 0) {
          total += count;
        }
      } catch {
        // Host without the table — it contributes nothing to the total.
      }
    })
  );
  return total;
}

function countHead(
  client: CountClient,
  table: string,
  expression: (chain: unknown) => unknown
): Promise<CountQueryResult> {
  return (expression(client.from(table)) as Promise<CountQueryResult>).then((r) => r);
}

/** Accepted friendships involving `profileId` (either direction). */
export function countFriendRows(projects: CountProjects[], profileId: string): Promise<number> {
  return sumHeadCounts(projects, (client) =>
    countHead(client, 'friends', (chain: any) =>
      chain
        .select('id', { count: 'exact', head: true })
        .or(`requester_id.eq.${profileId},receiver_id.eq.${profileId}`)
        .eq('status', 'accepted')
    )
  );
}

/** Rows in `followers` where `profileId` is the follower. */
export function countFollowingRows(projects: CountProjects[], profileId: string): Promise<number> {
  return sumHeadCounts(projects, (client) =>
    countHead(client, 'followers', (chain: any) =>
      chain.select('id', { count: 'exact', head: true }).eq('follower_id', profileId)
    )
  );
}

/** Rows in `followers` where `profileId` is being followed. */
export function countFollowerRows(projects: CountProjects[], profileId: string): Promise<number> {
  return sumHeadCounts(projects, (client) =>
    countHead(client, 'followers', (chain: any) =>
      chain.select('id', { count: 'exact', head: true }).eq('following_id', profileId)
    )
  );
}

export interface RelationshipCountProjects {
  friends: CountProjects[];
  followers: CountProjects[];
}

/** Real server-side counts for a profile, computed without leaking any rows. */
export async function getRelationshipCounts(
  projects: RelationshipCountProjects,
  profileId: string
): Promise<RelationshipCounts> {
  const [friends_count, following_count, followers_count] = await Promise.all([
    countFriendRows(projects.friends, profileId),
    countFollowingRows(projects.followers, profileId),
    countFollowerRows(projects.followers, profileId),
  ]);
  return { friends_count, following_count, followers_count };
}