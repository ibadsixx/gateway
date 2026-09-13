import { Router, Request, Response } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import busboy from 'busboy';
import { validation } from './validation';
import { database } from '../infrastructure/database';
import { storage } from '../infrastructure/storage';
import { ai } from '../infrastructure/ai';
import { projectRegistry } from '../registry/projectRegistry';
import { featureFlags } from '../features';
import { configCenter } from '../config';
import { rateLimiter } from '../rate-limiting';
import { metricsService } from '../metrics';
import { auditLogger } from '../audit';
import { serviceDiscovery } from '../discovery/registry';
import { eventBus } from '../events/bus';
import { jobQueue } from '../jobs/queue';
import { notificationQueue } from '../notifications';
import { searchService } from '../search';
import { projectManager } from '../project-manager';
import { auth, AuthCredentials } from '../auth';
import { projectHealth } from '../project-health';
import { infrastructureDb } from '../infrastructure/database/infrastructureDb';
import { authRouter } from './auth';
import { realtimeRouter } from './realtime';
import { ensureUserProfile } from '../profile-helper';
import { classifyMessageRequest } from '../features/messageRequestCategory';
import { leaveGroupConversation } from '../features/leaveGroupConversation';
import { publishChannelPost } from '../features/publishChannelPost';

// Applies the gateway-owned category to a `message_requests` insert body when
// the request is created (messages.md). The Gateway classifies because friends
// and conversations live in separate projects, so the DB trigger's
// `friends`/`restricted_users` references on the conversations host are not
// reliable. This is authoritative: it overrides any client-supplied value, and
// because exactly one Message Request is ever inserted per sender/receiver we
// need exactly one classification — "the category is created only when the
// first Message Request is made" and never changes with each message.
async function maybeClassifyMessageRequest(domain: string, body: unknown): Promise<void> {
  if (domain !== 'message_requests' || !body || typeof body !== 'object') return;
  const record = body as Record<string, unknown>;
  if (typeof record['sender_id'] === 'string' && typeof record['receiver_id'] === 'string') {
    console.log('[MessageRequest] classify', {
      sender_id: record['sender_id'],
      receiver_id: record['receiver_id'],
      conversation_id: (record['conversation_id'] as string | undefined) ?? null,
    });
    record['category'] = await classifyMessageRequest(
      record['sender_id'] as string,
      record['receiver_id'] as string
    );
    console.log('[MessageRequest] classified', {
      sender_id: record['sender_id'],
      receiver_id: record['receiver_id'],
      category: record['category'],
    });
  }
}

function requireProbeToken(req: Request, res: Response, next: () => void): void {
  const expected = process.env.KEEP_ALIVE_TOKEN || process.env.CRON_SECRET;
  if (!expected) {
    next();
    return;
  }
  if (req.headers.authorization === `Bearer ${expected}`) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

function applySupabaseFilters(query: any, filters: string | string[] | undefined): any {
  if (!filters) return query;
  const filterList = Array.isArray(filters) ? filters : [filters];
  for (const f of filterList) {
    // `or=(...)` carries a nested PostgREST filter expression whose value
    // contains dots and parens, so it can't go through the generic
    // column=op.value parser below. Handle it first and pass it straight
    // through to .or(). Previously it silently fell through to `default:
    // break`, which dropped the OR clause and could make a delete/filter
    // match far too many rows (e.g. unfriending one person deleting every
    // accepted friendship).
    if (f.startsWith('or=')) {
      let orExpr = f.slice('or='.length);
      // The client builder wraps the OR expression in parens (or=(a,b)).
      // supabase-js re-wraps the argument and PostgREST rejects the doubly
      // nested tree ("failed to parse logic tree (((a,b)))"), which made every
      // read that carried an `or=` filter return [] — e.g. the profile search
      // and friends list. Strip the client's outer paren layer before .or().
      while (orExpr.startsWith('(') && orExpr.endsWith(')') && orExpr.length >= 2) {
        orExpr = orExpr.slice(1, -1);
      }
      if (orExpr) query = query.or(orExpr);
      continue;
    }
    const eqIdx = f.indexOf('=');
    if (eqIdx === -1) continue;
    const column = f.slice(0, eqIdx);
    const rest = f.slice(eqIdx + 1);
    const dotIdx = rest.indexOf('.');
    if (dotIdx === -1) continue;
    const op = rest.slice(0, dotIdx);
    const value = rest.slice(dotIdx + 1);
    switch (op) {
      case 'eq': query = query.eq(column, value); break;
      case 'neq': query = query.neq(column, value); break;
      case 'gt': query = query.gt(column, value); break;
      case 'gte': query = query.gte(column, value); break;
      case 'lt': query = query.lt(column, value); break;
      case 'lte': query = query.lte(column, value); break;
      case 'like': query = query.like(column, value); break;
      case 'ilike': query = query.ilike(column, value); break;
      case 'in': {
        const items = value.replace(/^\(|\)$/g, '').split(',');
        query = query.in(column, items);
        break;
      }
      default: break;
    }
  }
  return query;
}

const v1 = Router();

const MAX_UPLOAD_SIZE = 150 * 1024 * 1024;

function parseMultipartUpload(req: Request): Promise<{ buffer: Buffer; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD_SIZE, fields: 10 } });
    let buffer = Buffer.alloc(0);
    let mimeType = 'application/octet-stream';

    bb.on('file', (_name, stream, info) => {
      mimeType = info.mimeType || mimeType;
      stream.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
      });
    });

    bb.on('error', (err) => reject(err));

    bb.on('close', () => {
      if (buffer.length === 0) {
        reject(new Error('No file received'));
        return;
      }
      resolve({ buffer, mimeType });
    });

    req.pipe(bb);
  });
}

// Apply auth middleware to all v1 routes except system endpoints
v1.use((req, res, next) => {
  // Skip auth for system endpoints
  if (req.path.startsWith('/system') || req.path === '/health') {
    return next();
  }
  return auth.authenticate(req, res, next);
});

v1.post('/:domain', validation.validateDomainMiddleware, async (req, res) => {
  const { domain } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    await maybeClassifyMessageRequest(domain, req.body);
    const denied = await enforceMessageWritePolicy(domain, req.user?.id, req.body);
    if (denied) {
      res.status(403).json({ error: denied });
      return;
    }
    const result = await database.write(domain, req.body);
    if (domain === 'message_requests') {
      console.log('[MessageRequest] request_created', { id: Array.isArray(result) ? result[0]?.id : result?.id });
    }
    res.status(201).json(result);
  } catch (error) {
    console.error(`[gateway] POST /api/v1/${domain} failed:`, error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
});

v1.get('/:domain/:id', validation.validateDomainMiddleware, async (req, res) => {
  const { domain, id } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const result = await database.read(domain, id);
    if (!result) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

v1.put('/:domain/:id', validation.validateDomainMiddleware, async (req, res) => {
  const { domain, id } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    console.log(`[gateway] PUT /api/v1/${domain}/${id}`, { body: req.body });
    // The category is fixed when the first Message Request is created and must
    // never be re-classified by a per-message update.
    if (domain === 'message_requests' && req.body && typeof req.body === 'object') {
      delete (req.body as Record<string, unknown>).category;
    }
    const result = await database.update(domain, id, req.body);
    console.log(`[gateway] PUT /api/v1/${domain}/${id} succeeded`);
    res.json(result);
  } catch (error) {
    console.error(`[gateway] PUT /api/v1/${domain}/${id} failed:`, error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
});

v1.delete('/:domain/:id', validation.validateDomainMiddleware, async (req, res) => {
  const { domain, id } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const permanent = req.query.permanent === 'true';
  try {
    await database.delete(domain, id, permanent);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

v1.delete('/:domain', validation.validateDomainMiddleware, async (req, res) => {
  const { domain } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const filters = req.query.filter as string[] | string | undefined;
  const permanent = req.query.permanent === 'true';
  if (!filters) {
    res.status(400).json({ error: 'No filters provided' });
    return;
  }
  try {
    const readableProjects = projectManager.getReadableProjects(domain);
    for (const entry of readableProjects) {
      try {
        let query = entry.client.from(domain).select('*');
        query = applySupabaseFilters(query, filters);
        const { data } = await query;
        if (data && (data as any[]).length > 0) {
          for (const row of data as any[]) {
            if (row.id) {
              await entry.client.from(domain).delete().eq('id', row.id);
            } else {
              let del = entry.client.from(domain).delete();
              for (const f of (Array.isArray(filters) ? filters : [filters])) {
                const eqIdx = f.indexOf('=');
                if (eqIdx === -1) continue;
                const col = f.slice(0, eqIdx);
                const rest = f.slice(eqIdx + 1);
                const dotIdx = rest.indexOf('.');
                if (dotIdx === -1) continue;
                const val = rest.slice(dotIdx + 1);
                del = del.eq(col, val);
              }
              await del;
            }
          }
        }
      } catch { /* skip */ }
    }
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

v1.delete('/conversations/:conversationId/leave', async (req, res) => {
  const { conversationId } = req.params;
  const userId = req.user?.id;
  if (!conversationId || !userId) {
    res.status(400).json({ error: 'Conversation and authenticated user are required' });
    return;
  }
  try {
    const result = await leaveGroupConversation(conversationId, userId);
    if (result.status === 'not_member') {
      res.status(404).json({ error: 'You are not a member of this conversation' });
      return;
    }
    if (result.status === 'not_group') {
      res.status(400).json({ error: 'Only group conversations can be left' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error(`[gateway] Leave group conversation ${conversationId} failed:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

v1.post('/conversations/:conversationId/publish', async (req, res) => {
  const { conversationId } = req.params;
  const userId = req.user?.id;
  if (!conversationId || !userId) {
    res.status(400).json({ error: 'Conversation and authenticated user are required' });
    return;
  }
  try {
    const result = await publishChannelPost(conversationId, userId, req.body || {});
    if (result.status === 'not_member') {
      res.status(404).json({ error: 'You are not a participant of this conversation' });
      return;
    }
    if (result.status === 'not_channel') {
      res.status(400).json({ error: 'Only channel conversations can be published to' });
      return;
    }
    if (result.status === 'not_publisher') {
      res.status(403).json({ error: 'Only channel admins can publish posts' });
      return;
    }
    res.status(201).json(result.message);
  } catch (error) {
    console.error(`[gateway] Publish channel post ${conversationId} failed:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

v1.post('/media/upload', async (req, res) => {
  try {
    const result = await storage.upload(req.body);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Upload failed' });
  }
});

v1.post('/moderation/text', async (req, res) => {
  try {
    const result = await ai.moderateText(req.body.content);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Moderation failed' });
  }
});

v1.post('/moderation/image', async (req, res) => {
  try {
    const result = await ai.moderateImage(req.body.url);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Moderation failed' });
  }
});

v1.get('/search/:domain', async (req, res) => {
  const { domain } = req.params;
  const query = req.query.q as string;
  if (!query) {
    res.status(400).json({ error: 'Query parameter q is required' });
    return;
  }
  try {
    const results = await searchService.search(domain, query);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

v1.post('/notifications/send', async (req, res) => {
  try {
    const notification = notificationQueue.enqueue(req.body);
    res.status(201).json(notification);
  } catch (error) {
    res.status(500).json({ error: 'Notification failed' });
  }
});

const system = Router();

// Public: health check only
system.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// All remaining system endpoints require admin authentication
system.use(auth.authenticateAdmin.bind(auth));

// One-off reconciliation: creates a `profiles` row for every auth user that
// predates profile auto-creation (they previously only existed in auth.users).
// Safe to re-run; skips accounts that already have a row.
system.post('/backfill-profiles', async (_req, res) => {
  try {
    const supabase = await auth.getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: 'Auth service not configured' });
      return;
    }

    let created = 0;
    let alreadyExisting = 0;
    const failed: Array<{ id: string; error: string }> = [];
    const perPage = 200;
    let page = 1;
    let users: any[] = [];

    do {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }
      users = data?.users || [];
      for (const u of users) {
        try {
          const result = await ensureUserProfile({
            id: u.id,
            email: u.email,
            user_metadata: (u.user_metadata || null) as Record<string, unknown> | null,
          });
          if (result.created) created++;
          else alreadyExisting++;
        } catch (err) {
          failed.push({ id: u.id, error: (err as Error).message });
        }
      }
      page++;
    } while (users.length === perPage);

    res.json({
      users_checked: created + alreadyExisting + failed.length,
      created,
      already_existing: alreadyExisting,
      failed: failed.length,
      failures: failed.slice(0, 20),
    });
  } catch (error) {
    console.error('[Backfill] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

system.get('/storage', async (_req, res) => {
  const status = await projectRegistry.getInfrastructureStatus();
  res.json(status.storage);
});

// /databases endpoint REMOVED — it exposed all Supabase service keys publicly.
// Use the Supabase Management API or direct project access for database operations.

system.get('/metrics', (_req, res) => {
  res.json(metricsService.getSnapshot());
});

system.get('/audit', (_req, res) => {
  res.json(auditLogger.getAll());
});

system.get('/config', async (_req, res) => {
  const config = await configCenter.getAll();
  res.json(config);
});

system.get('/features', (_req, res) => {
  res.json(featureFlags.getAll());
});

system.get('/services', (_req, res) => {
  res.json(serviceDiscovery.getAllServices());
});

system.get('/queue', (_req, res) => {
  res.json({ pending: jobQueue.length });
});

system.get('/rate-limits', (_req, res) => {
  res.json({ message: 'Check X-RateLimit headers on responses' });
});

system.post('/reload-registry', async (_req, res) => {
  try {
    await projectManager.refreshRegistry();
    res.json({ status: 'ok', message: 'Registry cache reloaded' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reload registry' });
  }
});

// Roles allowed to publish a top-level post into a channel. Channels are
// broadcast (messages.md): followers are read/reply-only, so only the channel
// owner and moderators may write new posts. `add_channel_follower` bolts a
// `follower` participant in, and the publish endpoint
// (/v1/conversations/:id/publish) already enforces this rule — but the generic
// `messages` insert route was a bypass: it ran with a service-key client that
// ignores RLS, so any authenticated caller could insert a top-level post into a
// channel as if it were a group chat. This helper closes that bypass for every
// messages insert path (composer fallback, forward, cross-post).
const CHANNEL_POST_ROLES = new Set(['owner', 'moderator']);

async function enforceMessageWritePolicy(
  domain: string,
  userId: string | undefined,
  body: unknown
): Promise<string | null> {
  if (domain !== 'messages' || !userId) return null;
  const rows = (Array.isArray(body) ? body : [body]) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;

  // The authenticated caller owns the send; the client never picks sender_id.
  for (const row of rows) {
    if (typeof row['sender_id'] !== 'string' || row['sender_id'] !== userId) {
      return 'Sender ID does not match authenticated user';
    }
  }

  const conversationId = rows[0]['conversation_id'];
  if (typeof conversationId !== 'string' || conversationId.length === 0) return null;

  // Channel posts require owner/moderator. Conversation and participant rows
  // live on the same physical host, so the client that locates the channel is
  // also used for the caller's role.
  for (const entry of projectManager.getReadableProjects('conversations')) {
    try {
      const { data: conv } = await entry.client
        .from('conversations')
        .select('type, created_by')
        .eq('id', conversationId)
        .maybeSingle();
      if (conv && (conv as { type?: string }).type === 'channel') {
        // `created_by` is the authoritative owner and always outranks the
        // participant row: a stale `follower` role must never demote them.
        // If `created_by` is missing, the participant row with role='owner'
        // pins the owner instead.
        const createdBy = (conv as { created_by?: string | null }).created_by ?? null;
        const isOwner = createdBy === userId;
        const [{ data: participant }, { data: ownerRow }] = await Promise.all([
          entry.client
            .from('conversation_participants')
            .select('role')
            .eq('conversation_id', conversationId)
            .eq('user_id', userId)
            .maybeSingle(),
          entry.client
            .from('conversation_participants')
            .select('user_id')
            .eq('conversation_id', conversationId)
            .eq('role', 'owner')
            .maybeSingle(),
        ]);
        const ownerFromRow = (ownerRow as { user_id?: string } | null)?.user_id ?? null;
        if (isOwner || (createdBy === null && ownerFromRow === userId)) return null;
        if (!participant) return 'You are not a participant of this conversation';
        if (!CHANNEL_POST_ROLES.has((participant as { role?: string }).role as string)) {
          return 'Only the channel owner or moderators can post';
        }
      }
      return null;
    } catch {
      // Try the next readable project.
    }
  }
  return 'Conversation not found';
}

const rpcRouter = Router();

// RPC functions that must run against a non-default project.
// The default RPC proxy targets the 'users' project; functions that operate on
// tables hosted elsewhere (e.g. ad topics in the advertisers project) are routed
// here by name to their owning domain. These are SECURITY DEFINER functions that
// take explicit parameters, so they run with the owning project's anon key.
const RPC_DOMAIN_OVERRIDES: Record<string, string> = {
  seed_default_ad_topics: 'ad_topics',
  add_blocked_nickname: 'blocking',
  add_blocked_sender: 'blocking',
  get_blocked_nicknames: 'blocking',
  remove_blocked_nickname: 'blocking',
  remove_blocked_sender: 'blocking',
  block_user: 'blocking',
  unblock_user: 'blocking',
  get_blocked_users: 'blocking',
  get_blocked_senders: 'blocking',
  get_blocked_user_ids: 'blocking',
  get_restricted_users: 'blocking',
  get_user_blocks: 'blocking',
  get_block_relation: 'blocking',
  is_blocked: 'blocking',
  is_restricted: 'blocking',
  restrict_user: 'blocking',
  unrestrict_user: 'blocking',
  // Conversation RPCs operate on tables hosted by the 'conversations' project.
  // Without this override they default to the 'users' project, which does not
  // host the conversation tables (calls fail with PGRST202 / 42P01). The
  // conversations project does not share the users JWT secret, so these
  // functions cannot read auth.uid() there; the gateway injects the verified
  // caller id into the RPC arguments instead (see RPC_INJECT_CALLER_ID).
  add_channel_follower: 'conversations',
  add_group_member: 'conversations',
  // The channel RPCs originally ran on the (pre-split) users host, but they
  // reference tables (conversations / conversation_participants) that now live
  // on the conversations host — calling them there returns 42P01. Route them
  // to the conversations project and inject the verified caller id. Fields
  // that need `profiles` (not present on the conversations host) are returned
  // as ids and enriched by the gateway afterwards (see enrichChannelRpcResponse).
  follow_channel: 'conversations',
  unfollow_channel: 'conversations',
  get_channel_user_role: 'conversations',
  get_channel_members: 'conversations',
  get_channel_stats: 'conversations',
  add_channel_moderator: 'conversations',
  remove_channel_moderator: 'conversations',
};

// Conversation-domain RPCs are SECURITY DEFINER functions whose auth.uid()
// check would see NULL on a cross-project anon call. The gateway replaces its
// own verified caller id into the function's caller argument before forwarding,
// so the function's permission checks run against the real user. Some functions
// call the actor `p_user_id`; the moderator helpers call it `p_caller_id` to
// keep the existing `p_user_id` argument as the moderator being added/removed.
const RPC_CALLER_ID_PARAM: Record<string, string> = {
  add_channel_follower: 'p_user_id',
  add_group_member: 'p_user_id',
  follow_channel: 'p_user_id',
  unfollow_channel: 'p_user_id',
  get_channel_user_role: 'p_user_id',
  get_channel_members: 'p_user_id',
  add_channel_moderator: 'p_caller_id',
  remove_channel_moderator: 'p_caller_id',
};

// Equivalent of the DB `get_channel_user_role` computed gateway-side. The DB
// function reads auth.uid(), which is NULL on the conversations host, so the
// proxied function resolves to no role for every caller. `conversations.created_by`
// is authoritative (the owner always wins, even with a stale `follower` row),
// otherwise the caller's participant row role is returned.
async function resolveChannelUserRole(
  userId: string | undefined,
  body: Record<string, unknown>
): Promise<string | null> {
  const conversationId = body && typeof body['p_conversation_id'] === 'string'
    ? (body['p_conversation_id'] as string)
    : null;
  if (!conversationId || !userId) return null;
  for (const entry of projectManager.getReadableProjects('conversations')) {
    try {
      const { data: conv } = await entry.client
        .from('conversations')
        .select('created_by')
        .eq('id', conversationId)
        .maybeSingle();
      if (!conv) return null;
      const createdBy = (conv as { created_by?: string | null }).created_by ?? null;
      if (createdBy === userId) return 'owner';
      const [participant, ownerRow] = await Promise.all([
        entry.client
          .from('conversation_participants')
          .select('role')
          .eq('conversation_id', conversationId)
          .eq('user_id', userId)
          .maybeSingle(),
        entry.client
          .from('conversation_participants')
          .select('user_id')
          .eq('conversation_id', conversationId)
          .eq('role', 'owner')
          .maybeSingle(),
      ]);
      const role = (participant?.data as { role?: string | null } | null)?.role ?? null;
      // When `created_by` is missing, the participant row with role='owner'
      // pins the owner — it must map to 'owner' even if the caller's own row
      // was overwritten to a stale `follower` role.
      const ownerId = (ownerRow?.data as { user_id?: string } | null)?.user_id ?? null;
      if (createdBy === null && ownerId === userId) return 'owner';
      return role === 'owner' || role === 'moderator' || role === 'follower' ? role : null;
    } catch {
      // Try the next readable project.
    }
  }
  return null;
}

// Channel RPCs run on the conversations host, which does not host `profiles`.
// Fields that need profile data (owner_name in get_channel_stats, and the
// member username/display_name/profile_pic in get_channel_members) are returned
// as ids and filled in here from the users host, preserving the exact response
// shape the client expects. Best-effort: on failure the ids are returned as-is.
async function enrichChannelRpcResponse(functionName: string, payload: unknown): Promise<unknown> {
  if (!payload || !Array.isArray(payload) || payload.length === 0) return payload;
  const profiles = projectManager.getReadableProjects('profiles');
  const profileClient = profiles[0]?.client;
  if (!profileClient) return payload;
  try {
    if (functionName === 'get_channel_stats') {
      for (const row of payload as Array<Record<string, unknown>>) {
        const ownerId = typeof row['owner_id'] === 'string' ? row['owner_id'] : null;
        if (!ownerId) {
          row['owner_name'] = 'Unknown';
          continue;
        }
        const { data } = await profileClient
          .from('profiles')
          .select('username, display_name')
          .eq('id', ownerId)
          .maybeSingle();
        const profile = data as { username?: string | null; display_name?: string | null } | null;
        row['owner_name'] = profile?.display_name || profile?.username || 'Unknown';
      }
      return payload;
    }
    if (functionName === 'get_channel_members') {
      const rows = payload as Array<Record<string, unknown>>;
      const ids = rows
        .map((r) => r['user_id'])
        .filter((id): id is string => typeof id === 'string');
      if (ids.length === 0) return payload;
      const { data } = await profileClient
        .from('profiles')
        .select('id, username, display_name, profile_pic')
        .in('id', ids);
      const byId = new Map<string, Record<string, unknown>>();
      for (const p of (data as Array<Record<string, unknown>>) || []) {
        byId.set(String(p['id']), p);
      }
      for (const row of rows) {
        const p = byId.get(String(row['user_id']));
        row['username'] = p?.username ?? null;
        row['display_name'] = p?.display_name ?? 'Unknown';
        row['profile_pic'] = p?.profile_pic ?? null;
      }
      return payload;
    }
  } catch (error) {
    console.warn(`[Gateway] Channel RPC enrichment failed for ${functionName}:`, error);
  }
  return payload;
}

rpcRouter.post('/:function', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  try {
    const domain = RPC_DOMAIN_OVERRIDES[req.params.function] || 'users';
    let credentials: AuthCredentials | null = null;
    let bearer: string | null = null;

    if (domain === 'users') {
      credentials = await auth.getProjectCredentials('users');
      bearer = auth.extractTokenFromHeader(req.headers.authorization);
    } else {
      const projects = projectManager.getReadableProjects(domain);
      const project = projects[0];
      if (project) {
        credentials = {
          project_url: project.project.projectUrl,
          anon_key: project.project.anonKey,
          service_key: project.project.serviceKey,
          jwt_secret: '',
        };
        // Functions routed to a non-default project run as that project's anon role
        // (they are SECURITY DEFINER and receive the acting user explicitly).
        bearer = project.project.anonKey;
      }
    }

    if (!credentials) {
      res.status(500).json({ error: 'Auth service not configured' });
      return;
    }
    if (!bearer) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }

    // Conversation RPCs can't read auth.uid() on the owning project (it does
    // not share the users JWT secret), so pass the gateway-verified caller id
    // as an explicit argument. req.user.id comes from the authenticated token,
    // never from the client body.
    const rpcName = req.params.function;
    let body = req.body || {};
    const callerIdParam = RPC_CALLER_ID_PARAM[rpcName];
    if (callerIdParam) {
      body = { ...(body as Record<string, unknown>) };
      if (req.user?.id) {
        (body as Record<string, unknown>)[callerIdParam] = req.user.id;
      }
    }

    // get_channel_user_role reads auth.uid(), which is NULL on the conversations
    // host (it does not share the users JWT secret) — the proxied function would
    // resolve to no role for every caller. Compute it here instead, using the
    // same tables as publish approval: conversations.created_by is authoritative
    // (the owner always reads as 'owner'), otherwise the participant role.
    if (rpcName === 'get_channel_user_role') {
      res.status(200).json(await resolveChannelUserRole(req.user?.id, body as Record<string, unknown>));
      return;
    }

    const url = `${credentials.project_url}/rest/v1/rpc/${encodeURIComponent(rpcName)}`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: credentials.anon_key,
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });

    const text = await upstream.text();

    if (upstream.status === 204) {
      res.status(200).json(null);
      return;
    }

    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!upstream.ok) {
      const message =
        (payload && typeof payload === 'object' && (payload as any).message) ||
        (payload && typeof payload === 'object' && (payload as any).msg) ||
        `RPC failed (${upstream.status})`;
      res.status(upstream.status === 404 ? 400 : upstream.status).json({ error: message });
      return;
    }

    res.status(200).json(await enrichChannelRpcResponse(rpcName, payload));
  } catch (error) {
    console.error('[Gateway] RPC proxy error:', error);
    res.status(502).json({ error: 'RPC proxy failed' });
  }
});

const router = Router();
router.use('/auth', authRouter);
router.use('/rpc', rpcRouter);
router.use('/realtime', realtimeRouter);
router.use('/v1', v1);
router.use('/system', system);
router.get('/health', (_req, res) => {
  res.redirect('/api/system/health');
});

// Apply auth middleware to non-v1 domain routes
router.post('/storage/:bucket/*', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  const { bucket } = req.params;
  const path = req.params[0];
  if (!bucket || !path) {
    res.status(400).json({ error: 'bucket and path are required' });
    return;
  }
  try {
    const { buffer, mimeType } = await parseMultipartUpload(req);
    const result = await storage.upload({ buffer, mimeType, bucket, path });
    res.status(201).json(result);
  } catch (error) {
    console.error('[Gateway] Storage upload failed:', (error as Error).message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// GET for previously-stored `/api/storage/...` URLs (the client's getPublicUrl
// fallback and any legacy profile_pic / cover_pic / media_url values stored in
// that dead form). The gateway has no file server; redirect to the Cloudinary
// CDN asset so stored avatar/cover/photo URLs render as <img> without auth.
router.get('/storage/:bucket/*', async (req: Request, res: Response) => {
  const { bucket } = req.params;
  const path = req.params[0];
  if (!bucket || !path) {
    res.status(400).json({ error: 'bucket and path are required' });
    return;
  }
  try {
    const resolved = await storage.resolvePublicUrl(path);
    if (!resolved) {
      res.status(404).json({ error: 'Storage not configured' });
      return;
    }
    res.redirect(302, resolved.url);
  } catch (error) {
    console.error('[Gateway] Storage resolve failed:', (error as Error).message);
    res.status(500).json({ error: 'Storage resolve failed' });
  }
});

// Project Health service — canonical mount plus the deprecated `/keep-alive` alias.
const projectHealthRouter = Router();

projectHealthRouter.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await projectHealth.getStatus());
  } catch (error) {
    console.error('[ProjectHealth] Status failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to collect project health status' });
  }
});

projectHealthRouter.get('/history/:projectKey', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
    const logs = await infrastructureDb.getHealthLogs('database', req.params.projectKey, limit);
    res.json(logs);
  } catch (error) {
    console.error('[ProjectHealth] History failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to load project health history' });
  }
});

// Vercel Cron sends GET; manual operators use POST. Default action is a
// scheduler tick (probes only projects whose slot is due); `?force=1` runs a
// full immediate round over every active project.
const runHandler = async (req: Request, res: Response) => {
  try {
    const force = String(req.query.force ?? '') === '1' || 'true';
    const result = force ? await projectHealth.runAll() : await projectHealth.tick();
    res.json(result);
  } catch (error) {
    console.error('[ProjectHealth] Run failed:', (error as Error).message);
    res.status(500).json({ error: 'Project health round failed' });
  }
};

projectHealthRouter.post('/run', requireProbeToken, runHandler);
projectHealthRouter.get('/run', requireProbeToken, runHandler);

// Registered before the top-level /:domain wildcards so they are never shadowed.
router.use('/project-health', projectHealthRouter);
/** @deprecated legacy alias — use /api/project-health instead. */
router.use('/keep-alive', projectHealthRouter);

router.post('/:domain', auth.authenticate.bind(auth), validation.validateDomainMiddleware, async (req, res) => {
  const { domain } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    await maybeClassifyMessageRequest(domain, req.body);
    const denied = await enforceMessageWritePolicy(domain, req.user?.id, req.body);
    if (denied) {
      res.status(403).json({ error: denied });
      return;
    }
    const result = await database.write(domain, req.body);
    if (domain === 'message_requests') {
      console.log('[MessageRequest] request_created', { id: Array.isArray(result) ? result[0]?.id : result?.id });
    }
    res.status(201).json(result);
  } catch (error) {
    console.error(`[gateway] POST /api/${domain} failed:`, error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
});

// Auth users live in the users project's `auth.users` schema, and there is no
// public `users` table, so the generic /:domain read below would return [] for
// "users". List them via the admin API instead and expose a stripped-down shape
// (`raw_user_meta_data` mirrors GoTrue's user_metadata) consistent with other
// domain rows the frontend reads.
router.get('/users', auth.authenticate.bind(auth), async (_req, res) => {
  try {
    const supabase = await auth.getSupabaseClient();
    if (!supabase) {
      res.status(500).json({ error: 'Auth service not configured' });
      return;
    }
    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json(
      (data?.users || []).map((u) => ({
        id: u.id,
        email: u.email ?? null,
        raw_user_meta_data: u.user_metadata ?? null,
        created_at: u.created_at ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
      }))
    );
  } catch (error) {
    console.error('[Auth] List users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:domain', auth.authenticate.bind(auth), validation.validateDomainMiddleware, async (req, res) => {
  const { domain } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const readableProjects = projectManager.getReadableProjects(domain);
    if (readableProjects.length === 0) {
      res.json([]);
      return;
    }
    const filters = req.query.filter as string[] | string | undefined;
    const requesterId = req.user?.id;
    const results = await Promise.all(
      readableProjects.map(async (entry) => {
        try {
          let query = entry.client.from(domain).select('*');
          query = applySupabaseFilters(query, filters);
          const { data, error } = await query;
          if (error) return [];
          let rows = (data as any[]) || [];
          // Presence privacy: for `profiles`, do NOT hand presence fields
          // (last_seen_at / manual_status / is_online) to a requester who is a
          // NON-FRIEND with a PENDING message request against the profile owner.
          // This makes presence "actually unavailable" (not just hidden in the
          // UI) per messages.md. Any pending request in EITHER direction hides
          // both users' presence; once accepted (or friends) it resumes under
          // the normal friendship/privacy rules.
          if (domain === 'profiles' && requesterId) {
            rows = await redactPendingRequestPresence(
              rows,
              requesterId,
              entry.client
            );
          }
          return rows;
        } catch {
          return [];
        }
      })
    );
    res.json(results.flat());
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Presence fields that reveal a user's online/activity state to a viewer.
const PRESENCE_FIELDS = ['last_seen_at', 'manual_status', 'is_online'] as const;

// Redacts presence fields on `profiles` rows for any user who has a PENDING
// message request with the requester (in either direction) and is NOT an
// accepted friend. Uses the same friendship/request tables the app already
// relies on (no second privacy system).
async function redactPendingRequestPresence(
  rows: any[],
  requesterId: string,
  client: SupabaseClient
): Promise<any[]> {
  const partnerIds = rows
    .map((r: any) => r?.id)
    .filter((id: unknown): id is string => typeof id === 'string' && id !== requesterId);
  if (partnerIds.length === 0) return rows;

  const [friendsRes, reqsRes] = await Promise.all([
    client
      .from('friends')
      .select('requester_id, receiver_id, status')
      .or(`requester_id.eq.${requesterId},receiver_id.eq.${requesterId}`),
    client
      .from('message_requests')
      .select('sender_id, receiver_id, status')
      .or(`sender_id.eq.${requesterId},receiver_id.eq.${requesterId}`),
  ]);

  const friends = new Set<string>();
  for (const f of (friendsRes.data || []) as any[]) {
    if (f?.status === 'accepted') {
      friends.add(f.requester_id === requesterId ? f.receiver_id : f.requester_id);
    }
  }

  // Map of partnerId -> true when there is a PENDING request in either direction.
  const pending = new Map<string, boolean>();
  for (const r of (reqsRes.data || []) as any[]) {
    const other = r?.sender_id === requesterId ? r?.receiver_id : r?.sender_id;
    if (typeof other !== 'string' || other === requesterId) continue;
    if (r?.status === 'accepted') {
      // Accepted requests count as a granted relationship (presence resumes).
      friends.add(other);
    } else if (r?.status === 'pending') {
      pending.set(other, true);
    }
  }

  return rows.map((row: any) => {
    const id = row?.id;
    if (typeof id !== 'string' || id === requesterId) return row;
    // Hide presence only for non-friend + pending.
    if (friends.has(id) || !pending.get(id)) return row;
    const redacted = { ...row };
    for (const field of PRESENCE_FIELDS) redacted[field] = null;
    return redacted;
  });
}

router.get('/:domain/:id', auth.authenticate.bind(auth), validation.validateDomainMiddleware, async (req, res) => {
  const { domain, id } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const result = await database.read(domain, id);
    if (!result) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router };
