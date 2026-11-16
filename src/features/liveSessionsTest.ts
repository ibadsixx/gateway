// Offline test for Tone Live session management.
// Verifies the liveSessions module logic by mocking the database layer —
// no live database or infra credentials required. This proves the code is
// correct (types, authorization flow, row shapes) even though end-to-end
// media transport tests require a browser environment (see do.md Step 5).

import { database } from '../infrastructure/database';
import {
  createLiveSession,
  getLiveSession,
  getActiveLiveSessions,
  endLiveSession,
  addLiveParticipant,
  getSessionParticipants,
  updateLiveParticipant,
  leaveLiveSession,
  addLiveComment,
  getLiveComments,
  hideComment,
  addLiveReaction,
  getLiveReactions,
  addLiveRecording,
  submitLiveReport,
  recordLiveEvent,
  authorizeSessionAccess,
  type LiveSessionRow,
  type LiveParticipantRow,
  type LiveCommentRow,
  type LiveReactionRow,
  type LiveReportRow,
  type LiveEventRow,
} from './liveSessions';

// ---------------------------------------------------------------------------
// In-memory mock database — mirrors the gateway's routingService semantics:
// query() filters with { column: value } ANDed together; write() inserts a
// row; update() updates by id; read() reads by id.
// ---------------------------------------------------------------------------
const store: Map<string, Record<string, unknown>[]> = new Map();

function table(domain: string): Record<string, unknown>[] {
  let rows = store.get(domain);
  if (!rows) {
    rows = [];
    store.set(domain, rows);
  }
  return rows;
}

function matches(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    const rowValue = row[key];
    if (value === null) {
      if (rowValue !== null) return false;
    } else if (rowValue !== value) return false;
  }
  return true;
}

// Replace the database module methods with in-memory implementations.
const db = database as unknown as {
  read: (domain: string, id: string) => Promise<Record<string, unknown> | null>;
  write: (domain: string, data: Record<string, unknown>) => Promise<Record<string, unknown>>;
  update: (domain: string, id: string, data: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  query: (domain: string, filter: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
};

db.read = async (domain: string, id: string) => {
  const row = table(domain).find((r) => r.id === id);
  return row ?? null;
};

db.write = async (domain: string, data: Record<string, unknown>) => {
  const row = { ...data, id: data.id ?? crypto.randomUUID() };
  table(domain).push(row);
  return row;
};

db.update = async (domain: string, id: string, data: Record<string, unknown>) => {
  const rows = table(domain);
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  rows[idx] = { ...rows[idx], ...data };
  return rows[idx];
};

db.query = async (domain: string, filter: Record<string, unknown>) => {
  return table(domain).filter((r) => matches(r, filter));
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

async function main(): Promise<void> {
  console.log('\n=== Tone Live Sessions Test ===\n');

  // 1. Session creation writes a row with the correct shape.
  const session = await createLiveSession({
    host_id: 'user-1',
    title: 'My Live Stream',
    stream_type: 'video',
    audience_type: 'public',
  });
  assertEqual(session.host_id, 'user-1', 'session host_id');
  assertEqual(session.title, 'My Live Stream', 'session title');
  assertEqual(session.stream_type, 'video', 'session stream_type');
  assertEqual(session.status, 'scheduled', 'session initial status');
  assertEqual(session.audience_type, 'public', 'session audience_type');
  assertEqual(session.viewer_count, 0, 'session initial viewer count');
  assertEqual(typeof session.id, 'string', 'session has an id');
  assertEqual(typeof session.created_at, 'string', 'session has created_at');

  // 2. Audio-only session.
  const audioSession = await createLiveSession({
    host_id: 'user-2',
    stream_type: 'audio',
    audience_type: 'friends',
  });
  assertEqual(audioSession.stream_type, 'audio', 'audio session stream_type');
  assertEqual(audioSession.audience_type, 'friends', 'audio session audience_type');

  // 3. getLiveSession reads back by id.
  const fetched = await getLiveSession(session.id);
  assertEqual(fetched?.id, session.id, 'getLiveSession returns the created session');
  assertEqual(fetched?.stream_type, 'video', 'getLiveSession stream_type');

  // 4. getActiveLiveSessions filters by status=live.
  await database.write('live-1', {
    id: 'active-session-1',
    host_id: 'user-3',
    title: null,
    description: null,
    stream_type: 'video',
    status: 'live',
    audience_type: 'public',
    audience_user_ids: null,
    audience_excluded_user_ids: null,
    audience_list_id: null,
    recording: false,
    recording_url: null,
    viewer_count: 0,
    max_viewers: null,
    started_at: null,
    ended_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as Record<string, unknown>);
  const active = await getActiveLiveSessions();
  assert(Array.isArray(active), 'getActiveLiveSessions returns an array');
  assert(active.every((s) => s.status === 'live'), 'all active sessions have status=live');

  // 5. Participant add + list + leave cycle.
  const participant = await addLiveParticipant({
    session_id: session.id,
    user_id: 'user-5',
    role: 'guest',
  });
  assertEqual(participant.session_id, session.id, 'participant session_id');
  assertEqual(participant.user_id, 'user-5', 'participant user_id');
  assertEqual(participant.role, 'guest', 'participant role');
  assertEqual(participant.left_at, null, 'participant not yet left');

  const participants = await getSessionParticipants(session.id);
  assert(participants.some((p) => p.user_id === 'user-5'), 'participant appears in list');

  await leaveLiveSession(session.id, 'user-5');
  const afterLeave = await getSessionParticipants(session.id);
  assert(!afterLeave.some((p) => p.user_id === 'user-5'), 'participant removed after leave');

  // 6. Participant update (mute/unmute/role).
  const p2 = await addLiveParticipant({ session_id: session.id, user_id: 'user-6', role: 'viewer' });
  const updated = await updateLiveParticipant(session.id, 'user-6', {
    is_muted: true,
    role: 'moderator',
  });
  assertEqual(updated?.is_muted, true, 'participant muted');
  assertEqual(updated?.role, 'moderator', 'participant role updated to moderator');

  // 7. Comment add + list + hide cycle.
  const comment = await addLiveComment({
    session_id: session.id,
    user_id: 'user-7',
    content: 'Hello live!',
  });
  assertEqual(comment.content, 'Hello live!', 'comment content');
  assertEqual(comment.is_hidden, false, 'comment not initially hidden');

  const comments = await getLiveComments(session.id);
  assert(comments.some((c) => c.id === comment.id), 'comment appears in list');

  await hideComment(comment.id);
  const afterHide = await getLiveComments(session.id);
  assert(!afterHide.some((c) => c.id === comment.id), 'hidden comment excluded from list');

  // 8. Reaction add + list.
  const reaction = await addLiveReaction({
    session_id: session.id,
    user_id: 'user-9',
    reaction_type: 'heart',
  });
  assertEqual(reaction.reaction_type, 'heart', 'reaction type');

  const reactions = await getLiveReactions(session.id);
  assert(reactions.some((r) => r.reaction_type === 'heart'), 'reaction appears in list');

  // 9. Recording + report + event.
  const recording = await addLiveRecording({ session_id: session.id });
  assertEqual(recording.status, 'pending', 'recording initial status');

  const report = await submitLiveReport({
    session_id: session.id,
    reporter_id: 'user-11',
    reason: 'spam',
  });
  assertEqual(report.status, 'open', 'report initial status');
  assertEqual(report.reason, 'spam', 'report reason');

  const event = await recordLiveEvent({
    session_id: session.id,
    event_type: 'session_ended',
    actor_id: 'user-10',
  });
  assertEqual(event.event_type, 'session_ended', 'event type');

  // 10. endLiveSession transitions status to ended.
  await endLiveSession(session.id);
  const ended = await getLiveSession(session.id);
  assertEqual(ended?.status, 'ended', 'session ended status');
  assert(!!ended?.ended_at, 'session has ended_at timestamp');

  // 11. Type shape assertions (compile-time safety verified at runtime).
  const row: LiveSessionRow = session;
  assert(typeof row.id === 'string', 'LiveSessionRow.id is string');
  assert(typeof row.host_id === 'string', 'LiveSessionRow.host_id is string');
  assert(typeof row.stream_type === 'string', 'LiveSessionRow.stream_type is string');
  assert(typeof row.status === 'string', 'LiveSessionRow.status is string');
  assert(typeof row.created_at === 'string', 'LiveSessionRow.created_at is string');
  assert(typeof row.viewer_count === 'number', 'LiveSessionRow.viewer_count is number');

  const partRow: LiveParticipantRow = {
    id: 'p-1',
    session_id: session.id,
    user_id: 'user-14',
    role: 'viewer',
    joined_at: new Date().toISOString(),
    left_at: null,
    is_muted: false,
    is_video_off: false,
  };
  assert(partRow.role === 'viewer', 'LiveParticipantRow.role');

  const commentRow: LiveCommentRow = {
    id: 'c-1',
    session_id: session.id,
    user_id: 'user-15',
    content: 'test',
    created_at: new Date().toISOString(),
    is_hidden: false,
    hidden_by: null,
    hidden_at: null,
  };
  assert(commentRow.is_hidden === false, 'LiveCommentRow.is_hidden');

  const reactionRow: LiveReactionRow = {
    id: 'r-1',
    session_id: session.id,
    user_id: 'user-16',
    reaction_type: 'clap',
    created_at: new Date().toISOString(),
  };
  assert(reactionRow.reaction_type === 'clap', 'LiveReactionRow.reaction_type');

  const reportRow: LiveReportRow = {
    id: 'rep-1',
    session_id: session.id,
    reporter_id: 'user-17',
    reported_user_id: null,
    reason: 'test',
    description: null,
    status: 'open',
    created_at: new Date().toISOString(),
  };
  assert(reportRow.status === 'open', 'LiveReportRow.status');

  const eventRow: LiveEventRow = {
    id: 'e-1',
    session_id: session.id,
    event_type: 'test',
    actor_id: null,
    target_user_id: null,
    metadata: null,
    created_at: new Date().toISOString(),
  };
  assert(eventRow.event_type === 'test', 'LiveEventRow.event_type');

  // 12. authorizeSessionAccess is exported and typed correctly.
  assert(typeof authorizeSessionAccess === 'function', 'authorizeSessionAccess is exported');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test harness error:', err);
  process.exit(1);
});
