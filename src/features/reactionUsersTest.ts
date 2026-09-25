// Offline regression tests for reaction-list authorization, aggregate counts,
// and server-side pagination. Run with: npm run test:reaction-users
import assert from 'node:assert/strict';
import {
  canonicalReactionType,
  enrichReactionUsers,
  filterPostReactionRows,
  getReactionTypeCounts,
  getReactionUsersPage,
  normalizeReactionVisibility,
  resolveReactionContent,
  type ReactionClient,
  type ReactionProject,
  type ReactionRow,
} from './reactionUsers';

const POST_ID = '11111111-1111-4111-8111-111111111111';
const COMMENT_ID = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FRIEND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STRANGER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VIEWER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}:`, error);
  }
}

/** Small PostgREST-like fake with the chain methods used by the feature. */
class FakeClient implements ReactionClient {
  readonly calls: Array<{ table: string; select?: string; filters: string[]; ranged?: boolean }> = [];
  private readonly tables: Record<string, ReactionRow[]>;

  constructor(tables: Record<string, ReactionRow[]>) {
    this.tables = tables;
  }

  from(table: string): any {
    const rows = this.tables[table] || [];
    const call: { table: string; select?: string; filters: string[]; ranged?: boolean } = {
      table,
      filters: [],
    };
    this.calls.push(call);
    const state = call;
    const owner = this;
    const query: any = {
      select(columns: string) {
        state.select = columns;
        return query;
      },
      eq(column: string, value: unknown) {
        state.filters.push(`${column}=${String(value)}`);
        return query;
      },
      in(column: string, values: unknown[]) {
        state.filters.push(`${column}in=${values.map(String).join(',')}`);
        return query;
      },
      or(expression: string) {
        state.filters.push(`or=${expression}`);
        return query;
      },
      limit(value: number) {
        state.filters.push(`limit=${value}`);
        return query;
      },
      order() {
        return query;
      },
      range(start: number, end: number) {
        state.ranged = true;
        state.filters.push(`range=${start}-${end}`);
        return query;
      },
      maybeSingle() {
        const result = owner.execute(rows, state, false);
        return Promise.resolve({
          data: result[0] || null,
          error: result[0] ? null : { message: 'No rows returned' },
        });
      },
      then: (resolve: (value: { data: ReactionRow[] | ReactionRow | null; error: unknown }) => unknown) => {
        const result = this.execute(rows, state, Array.isArray(resultValue(state)));
        return Promise.resolve(resolve({ data: result, error: null }));
      },
    };
    // `then` needs to know whether maybeSingle was requested. Keep a separate
    // marker rather than relying on the return shape of execute().
    (query as any)._maybe = false;
    const originalMaybeSingle = query.maybeSingle;
    query.maybeSingle = () => {
      (query as any)._maybe = true;
      return originalMaybeSingle();
    };
    return query;
  }

  private execute(rows: ReactionRow[], state: any, _unused: boolean): ReactionRow[] {
    let output = rows.slice();
    for (const filter of state.filters) {
      const [left, right] = filter.split('=');
      if (left === 'or') {
        const [a, b] = right.split(',');
        const [aCol, aOp, aVal] = a.split('.');
        const [bCol, bOp, bVal] = b.split('.');
        if (aOp !== 'eq' || bOp !== 'eq') continue;
        output = output.filter((row) => String(row[aCol]) === aVal || String(row[bCol]) === bVal);
        continue;
      }
      if (left?.endsWith('in')) {
        const col = left.slice(0, -2);
        const values = new Set(right.split(','));
        output = output.filter((row) => values.has(String(row[col])));
        continue;
      }
      if (left === 'limit') {
        output = output.slice(0, Number(right));
        continue;
      }
      if (left === 'range') {
        const [start, end] = right.split('-').map(Number);
        output = output.slice(start, end + 1);
        continue;
      }
      output = output.filter((row) => String(row[left]) === right);
    }
    return output;
  }
}

function resultValue(_state: any): unknown[] {
  return [];
}

function project(client: FakeClient): ReactionProject {
  return { client };
}

async function main() {
  check('legacy post type maps to canonical key', canonicalReactionType('like', 'post'), 'ok');
  check('legacy comment emoji maps to canonical key', canonicalReactionType('❤️', 'comment'), 'red_heart');
  check('restricted is normalized to only_me', normalizeReactionVisibility('Restricted'), 'only_me');
  check('unknown visibility fails closed to public', normalizeReactionVisibility('nonsense'), 'public');

  const reactionRows: ReactionRow[] = [
    { id: 'r1', post_id: POST_ID, user_id: FRIEND, type: 'ok', created_at: '2026-01-01T00:00:00Z' },
    { id: 'r2', post_id: POST_ID, user_id: STRANGER, type: 'red_heart', created_at: '2026-01-02T00:00:00Z' },
    { id: 'r3', post_id: POST_ID, user_id: VIEWER, type: 'ok', created_at: '2026-01-03T00:00:00Z' },
  ];
  const tables: Record<string, ReactionRow[]> = {
    reactions: reactionRows,
    posts: [{ id: POST_ID, user_id: OWNER, visibility: 'public', audience_type: 'public', status: 'published' }],
    comments: [{ id: COMMENT_ID, post_id: POST_ID, user_id: OWNER }],
    privacy_settings: [],
    friends: [],
    profiles: [
      { id: FRIEND, username: 'friend', display_name: 'Friend', profile_pic: 'friend.jpg', email: 'secret@example.com' },
      { id: STRANGER, username: 'stranger', display_name: 'Stranger', profile_pic: null },
      { id: VIEWER, username: 'viewer', display_name: 'Viewer', profile_pic: null },
    ],
  };
  const reactionClient = new FakeClient(tables);
  const reactionProjects = [project(reactionClient)];

  const counts = await getReactionTypeCounts(reactionProjects, 'post', POST_ID);
  check('aggregate count is independent of identity filtering', counts, {
    reaction_count: 3,
    reaction_types: { ok: 2, red_heart: 1 },
  });
  const aggregateCall = reactionClient.calls.find((call) => call.select === 'type');
  check('aggregate query selects only the type column', aggregateCall?.select, 'type');
  check('aggregate query never selects user_id', aggregateCall?.select?.includes('user_id'), false);

  const page = await getReactionUsersPage(reactionProjects, 'post', POST_ID, { limit: 2, offset: 0 });
  check('page returns newest rows and a continuation offset', {
    ids: page.users.map((row) => row.id),
    has_more: page.has_more,
    next_offset: page.next_offset,
  }, { ids: ['r3', 'r2'], has_more: true, next_offset: 2 });
  check('page count is the full aggregate count', page.reaction_count, 3);

  const publicResolution = await resolveReactionContent('post', POST_ID, undefined, {
    posts: reactionProjects,
    comments: reactionProjects,
    privacySettings: reactionProjects,
    friends: reactionProjects,
  });
  check('guest may view a public post reactor list', {
    status: publicResolution.status,
    visible: publicResolution.contentVisible,
    users: publicResolution.canViewUsers,
  }, { status: 'allowed', visible: true, users: true });

  const publicFiltered = await filterPostReactionRows(reactionRows, VIEWER, {
    posts: reactionProjects,
    comments: reactionProjects,
    privacySettings: reactionProjects,
    friends: reactionProjects,
  });
  check('public setting permits the authorized direct list', publicFiltered.map((row) => row.id), ['r1', 'r2', 'r3']);

  tables.privacy_settings = [{ user_id: OWNER, setting_name: 'reactions_visibility', setting_value: 'only_me' }];
  const privateResolution = await resolveReactionContent('post', POST_ID, STRANGER, {
    posts: reactionProjects,
    comments: reactionProjects,
    privacySettings: reactionProjects,
    friends: reactionProjects,
  });
  check('non-owner cannot view a restricted reactor list', privateResolution.canViewUsers, false);
  const ownerResolution = await resolveReactionContent('post', POST_ID, OWNER, {
    posts: reactionProjects,
    comments: reactionProjects,
    privacySettings: reactionProjects,
    friends: reactionProjects,
  });
  check('owner always bypasses the reactor-list restriction', ownerResolution.canViewUsers, true);

  const privateFiltered = await filterPostReactionRows(reactionRows, STRANGER, {
    posts: reactionProjects,
    comments: reactionProjects,
    privacySettings: reactionProjects,
    friends: reactionProjects,
  });
  check('restricted direct list exposes only the requester own state row', privateFiltered.map((row) => row.id), ['r2']);

  const enriched = await enrichReactionUsers(page.users, [
    project(new FakeClient({
      profiles: [
        { id: VIEWER, username: 'viewer', display_name: 'Viewer', profile_pic: null },
        { id: STRANGER, username: 'stranger', display_name: 'Stranger', profile_pic: null },
      ],
    })),
  ]);
  check('profile enrichment exposes only the public projection', Object.keys(enriched[0]).sort(), [
    'created_at',
    'display_name',
    'id',
    'profile_pic',
    'reaction_type',
    'user_id',
    'username',
  ]);

  console.log(`\nreaction-users: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
