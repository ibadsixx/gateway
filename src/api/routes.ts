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
import { filterScheduledPosts, isForeignScheduledPost } from '../features/scheduledPostPrivacy';
import { removeChannelMember } from '../features/removeChannelMember';
import { addChannelModerator, removeChannelModerator } from '../features/channelModerator';
import { deleteChannel } from '../features/deleteChannel';
import { addChannelFollower } from '../features/addChannelFollower';
import {
  restrictStoryReactionsRead,
  restrictStoryViewsRead,
  restrictStoryRowsRead,
  storyReactionWriteDenied,
  bumpStoryViewsCount,
} from '../features/storyPrivacy';
import {
  createGroup,
  updateGroupSettings,
  updateGroupCover,
  setGroupRulesEnabled,
  listGroupRules,
  addGroupRule,
  updateGroupRule,
  deleteGroupRule,
  reorderGroupRules,
  type GroupRulesResult,
} from '../features/groupSettings';
import {
  listGroupMembers,
  addGroupMembers,
  removeGroupMember,
  reportGroupMember,
  restrictGroupMember,
  unrestrictGroupMember,
  banGroupMember,
  unbanGroupMember,
  shareGroupPost,
  type MembersListResult,
  type MemberActionResult,
} from '../features/groupMembers';
import {
  evaluateChannelMessageGate,
  stripNonEditable,
} from '../features/channelMessageGate';
import { evaluatePinPolicy, evaluatePinDeletePolicy } from '../features/channelPinGate';
import { resolveChannelContext, isChannel, isOwnerOf, isModeratorOf } from '../features/channelContext';
import { computeChannelStats } from '../features/channelStats';
import { computePeopleYouMayKnow } from '../features/peopleYouMayKnow';

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

// Group settings + "Group Rules" (message.md). These are registered BEFORE the
// generic /:domain routes below so the generic service-role routes (which do no
// authorization) can never be used to modify group settings or rules. Every
// identity and permission is resolved from the database in the feature module.
function sendGroupRulesResult(res: Response, result: GroupRulesResult): void {
  switch (result.status) {
    case 'ok':
      res.json(result.rules);
      return;
    case 'not_authenticated':
      res.status(401).json({ error: 'Authentication required' });
      return;
    case 'group_not_found':
      res.status(404).json({ error: 'Group not found' });
      return;
    case 'not_owner':
      res.status(403).json({ error: 'Only the group owner can manage group rules' });
      return;
    case 'forbidden':
      res.status(403).json({ error: 'You do not have access to this group' });
      return;
    case 'rule_not_found':
      res.status(404).json({ error: 'Rule not found' });
      return;
    case 'invalid':
      res.status(400).json({ error: result.message });
      return;
  }
}

// Group member management + moderation (message.md). Results use the same
// status vocabulary as the rules routes so the two senders stay consistent.
function sendMembersListResult(res: Response, result: MembersListResult): void {
  switch (result.status) {
    case 'ok':
      res.json(result);
      return;
    case 'not_authenticated':
      res.status(401).json({ error: 'Authentication required' });
      return;
    case 'group_not_found':
      res.status(404).json({ error: 'Group not found' });
      return;
    case 'forbidden':
      res.status(403).json({ error: 'You do not have access to this group' });
      return;
  }
}

function sendMemberActionResult(res: Response, result: MemberActionResult): void {
  switch (result.status) {
    case 'ok':
      res.json(result);
      return;
    case 'not_authenticated':
      res.status(401).json({ error: 'Authentication required' });
      return;
    case 'group_not_found':
      res.status(404).json({ error: 'Group not found' });
      return;
    case 'not_allowed':
      res.status(403).json({ error: result.message });
      return;
    case 'target_not_found':
      res.status(404).json({ error: 'Member not found' });
      return;
    case 'rule_not_found':
      res.status(404).json({ error: 'Rule not found' });
      return;
    case 'invalid':
      res.status(400).json({ error: result.message });
      return;
  }
}

// Express 4 does not forward rejected promises from async handlers to the error
// middleware. A failed Group write therefore used to leave the request open
// until the platform timeout (the client saw a hung request and the rules
// toggle never settled). Every Group route is wrapped so a storage failure
// becomes a real error response instead of an unanswered request.
type GroupRouteHandler = (req: Request, res: Response) => Promise<void>;

// Classify the ORIGINAL backend error so developer logs (and, when enabled,
// developer responses) surface the precise root cause instead of only the
// generic GROUP_OPERATION_FAILED wrapper. No database internals or secrets
// are placed in the production response body.
function classifyGroupError(error: unknown): {
  code: string;
  message: string;
  domain?: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const readable = message.match(/No readable projects for domain: (\S+)/);
  if (readable) return { code: 'DOMAIN_NOT_REGISTERED', message, domain: readable[1] };
  const writable = message.match(/No writable project registered for group table '(\S+)'/);
  if (writable) return { code: 'GROUP_WRITABLE_PROJECT_MISSING', message, domain: writable[1] };
  const relation = message.match(/relation "public\.(\w+)" does not exist/);
  if (relation) return { code: 'GROUP_TABLE_MISSING', message, domain: relation[1] };
  return { code: 'GROUP_HANDLER_ERROR', message };
}

function groupRoute(handler: GroupRouteHandler) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      // Log the REAL failure with operation context (pro.md: the original
      // error must never be masked). Includes the classified code and the
      // target domain/table involved when the error names one.
      const classified = classifyGroupError(error);
      console.error(
        `[groups] ${req.method} ${req.originalUrl} failed:`,
        JSON.stringify({
          code: classified.code,
          errorMessage: classified.message,
          ...(classified.domain ? { domain: classified.domain } : {}),
          status: 500,
          groupId: typeof req.params?.groupId === 'string' ? req.params.groupId : null,
          memberId: typeof req.params?.memberId === 'string' ? req.params.memberId : null,
          userId: req.user?.id ?? null,
        })
      );
      if (!res.headersSent) {
        // Default production payload: structured, no DB internals.
        const payload: Record<string, string> = {
          error: 'GROUP_OPERATION_FAILED',
          message: 'Group operation failed',
        };
        // Debug (+GROUP_DEBUG_RESPONSE=1) intentionally surfaces the original
        // error so a developer can capture the real cause in the response body
        // without Vercel log access. Off by default; never on in production.
        if (process.env.GROUP_DEBUG_RESPONSE === '1') {
          payload.originalError = classified.message;
          payload.code = classified.code;
          if (classified.domain) payload.domain = classified.domain;
        }
        res.status(500).json(payload);
      }
    }
  };
}

// Create a group. The Gateway (never the client) validates name/privacy and
// stamps created_by with the authenticated user, then creates the owner
// membership row atomically.
v1.post('/groups', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const body = (req.body || {}) as Record<string, unknown>;
  const result = await createGroup(req.user?.id, {
    name: body['name'],
    description: body['description'],
    privacy: body['privacy'],
  });
  switch (result.status) {
    case 'ok':
      res.status(201).json(result.group);
      return;
    case 'not_authenticated':
      res.status(401).json({ error: 'Authentication required' });
      return;
    case 'invalid':
      res.status(400).json({ error: result.message });
      return;
    case 'unavailable':
      res.status(503).json({ error: 'Group storage unavailable' });
      return;
  }
}));

// Update Group Name (required), Description (optional) and Privacy (required).
v1.put('/groups/:groupId/settings', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const body = (req.body || {}) as Record<string, unknown>;
  const result = await updateGroupSettings(req.params.groupId, req.user?.id, {
    name: body['name'],
    description: body['description'],
    privacy: body['privacy'],
  });
  switch (result.status) {
    case 'ok':
      res.json(result.group);
      return;
    case 'not_authenticated':
      res.status(401).json({ error: 'Authentication required' });
      return;
    case 'group_not_found':
      res.status(404).json({ error: 'Group not found' });
      return;
    case 'not_owner':
      res.status(403).json({ error: 'Only the group owner can edit group settings' });
      return;
    case 'invalid':
      res.status(400).json({ error: result.message });
      return;
  }
}));

// Update the group cover image (owner only). Replaces the previously
// unauthenticated generic PUT /:domain/:id path for `groups`.
v1.put('/groups/:groupId/cover', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const coverImage = (req.body as Record<string, unknown> | undefined)?.['cover_image'];
  const result = await updateGroupCover(req.params.groupId, req.user?.id, coverImage);
  switch (result.status) {
    case 'ok':
      res.json(result.group);
      return;
    case 'not_authenticated':
      res.status(401).json({ error: 'Authentication required' });
      return;
    case 'group_not_found':
      res.status(404).json({ error: 'Group not found' });
      return;
    case 'not_owner':
      res.status(403).json({ error: 'Only the group owner can edit group settings' });
      return;
    case 'invalid':
      res.status(400).json({ error: result.message });
      return;
  }
}));

// Enable/disable the optional Group Rules feature (owner only).
v1.put('/groups/:groupId/rules-enabled', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const enabled = (req.body as Record<string, unknown> | undefined)?.['rules_enabled'];
  const result = await setGroupRulesEnabled(req.params.groupId, req.user?.id, enabled);
  switch (result.status) {
    case 'ok':
      res.json(result.group);
      return;
    case 'not_authenticated':
      res.status(401).json({ error: 'Authentication required' });
      return;
    case 'group_not_found':
      res.status(404).json({ error: 'Group not found' });
      return;
    case 'not_owner':
      res.status(403).json({ error: 'Only the group owner can change this setting' });
      return;
    case 'invalid':
      res.status(400).json({ error: result.message });
      return;
  }
}));

// List rules (owner, members, and — for public groups — any authenticated user).
v1.get('/groups/:groupId/rules', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  sendGroupRulesResult(res, await listGroupRules(req.params.groupId, req.user?.id));
}));

// Add a rule (owner only).
v1.post('/groups/:groupId/rules', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const ruleText = (req.body as Record<string, unknown> | undefined)?.['rule_text'];
  sendGroupRulesResult(res, await addGroupRule(req.params.groupId, req.user?.id, ruleText));
}));

// Reorder rules (owner only). Registered before the /rules/:ruleId route so
// "reorder" is never captured as a rule id.
v1.put('/groups/:groupId/rules/reorder', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const orderedIds = (req.body as Record<string, unknown> | undefined)?.['ordered_ids'];
  sendGroupRulesResult(res, await reorderGroupRules(req.params.groupId, req.user?.id, orderedIds));
}));

// Edit a rule (owner only).
v1.put('/groups/:groupId/rules/:ruleId', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const ruleText = (req.body as Record<string, unknown> | undefined)?.['rule_text'];
  sendGroupRulesResult(
    res,
    await updateGroupRule(req.params.groupId, req.user?.id, req.params.ruleId, ruleText)
  );
}));

// Delete a rule (owner only).
v1.delete('/groups/:groupId/rules/:ruleId', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  sendGroupRulesResult(
    res,
    await deleteGroupRule(req.params.groupId, req.user?.id, req.params.ruleId)
  );
}));

// --- Group member management + moderation (message.md) ---
//
// These are registered BEFORE the generic /:domain routes so the generic
// service-role routes (which do no authorization) can never add/remove members,
// ban/restrict/remove another member, or share posts on someone's behalf. Every
// identity and permission is resolved from the database in the feature module.

// Members list (roster + active restriction status; banned members & moderation
// history are included for the owner/moderators only).
v1.get('/groups/:groupId/members', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  sendMembersListResult(res, await listGroupMembers(req.params.groupId, req.user?.id));
}));

// Join (self) or invite members (owner/moderator adds others, banned users are
// refused). Body: { user_id } | { user_ids: [...] }.
v1.post('/groups/:groupId/members', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const body = (req.body || {}) as Record<string, unknown>;
  sendMemberActionResult(
    res,
    await addGroupMembers(req.params.groupId, req.user?.id, {
      user_id: body['user_id'],
      user_ids: body['user_ids'],
    })
  );
}));

// Leave (self) or remove a member (owner/moderator with hierarchy checks).
// Body: { reason? } (used for moderator removals).
v1.delete('/groups/:groupId/members/:memberId', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const body = (req.body || {}) as Record<string, unknown>;
  sendMemberActionResult(
    res,
    await removeGroupMember(req.params.groupId, req.user?.id, req.params.memberId, {
      reason: body['reason'],
    })
  );
}));

// Report a group member (any member may report; mirrors profile_reports).
v1.post('/groups/:groupId/members/:memberId/report', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const body = (req.body || {}) as Record<string, unknown>;
  sendMemberActionResult(
    res,
    await reportGroupMember(req.params.groupId, req.user?.id, req.params.memberId, {
      reason: body['reason'],
      description: body['description'],
    })
  );
}));

// Restrict a member: { restriction_type: 'posting' | 'all', ends_at?, reason?,
// rule_id? } (ties into Group Rules when the caller picks an existing rule).
v1.post('/groups/:groupId/members/:memberId/restrict', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const body = (req.body || {}) as Record<string, unknown>;
  sendMemberActionResult(
    res,
    await restrictGroupMember(req.params.groupId, req.user?.id, req.params.memberId, {
      restriction_type: body['restriction_type'],
      ends_at: body['ends_at'],
      reason: body['reason'],
      rule_id: body['rule_id'],
    })
  );
}));

// Lift an active restriction. Body: { restriction_type? } to target one type.
v1.post('/groups/:groupId/members/:memberId/unrestrict', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const body = (req.body || {}) as Record<string, unknown>;
  sendMemberActionResult(
    res,
    await unrestrictGroupMember(req.params.groupId, req.user?.id, req.params.memberId, {
      restriction_type: body['restriction_type'],
    })
  );
}));

// Ban a member: { ends_at?, reason?, rule_id? }. Bans the member, removes their
// membership (they cannot rejoin while active), and revokes active restrictions.
v1.post('/groups/:groupId/members/:memberId/ban', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const body = (req.body || {}) as Record<string, unknown>;
  sendMemberActionResult(
    res,
    await banGroupMember(req.params.groupId, req.user?.id, req.params.memberId, {
      ends_at: body['ends_at'],
      reason: body['reason'],
      rule_id: body['rule_id'],
    })
  );
}));

// Unban a member (revokes the active ban; they rejoin via the normal flow).
v1.post('/groups/:groupId/members/:memberId/unban', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  sendMemberActionResult(
    res,
    await unbanGroupMember(req.params.groupId, req.user?.id, req.params.memberId)
  );
}));

// Share a post into a group (author is always the caller; restricted members
// are blocked). Body: { post_id, message? }.
v1.post('/groups/:groupId/posts', groupRoute(async (req, res) => {
  if (!featureFlags.isEnabled('groups')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const body = (req.body || {}) as Record<string, unknown>;
  sendMemberActionResult(
    res,
    await shareGroupPost(req.params.groupId, req.user?.id, {
      post_id: body['post_id'],
      message: body['message'],
    })
  );
}));

// Rename / re-describe a channel — moderator permission (messages.md). The
// generic PUT /:domain/:id route ran with a service-key client that ignores
// RLS, so a follower could rewrite the channel name/description by calling the
// gateway directly. Owner/moderators pass; other channel callers are denied;
// non-channel conversations keep the generic behaviour.
v1.put('/conversations/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const userId = req.user?.id;
  if (!featureFlags.isEnabled('conversations')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!conversationId || !userId) {
    res.status(400).json({ error: 'Conversation and authenticated user are required' });
    return;
  }
  const ctx = await resolveChannelContext(conversationId, userId);
  if (!ctx) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  if (!isChannel(ctx)) {
    const result = await database.update('conversations', conversationId, req.body);
    res.json(result);
    return;
  }
  if (!isOwnerOf(ctx, userId) && !isModeratorOf(ctx, userId)) {
    res.status(403).json({ error: 'Only the channel owner or moderators can edit the channel' });
    return;
  }
  const clean: Record<string, unknown> = {};
  if (req.body && typeof req.body === 'object') {
    const body = req.body as Record<string, unknown>;
    if (typeof body['name'] === 'string') clean['name'] = body['name'];
    if ('description' in body) clean['description'] = body['description'] ?? null;
  }
  if (!('name' in clean) && !('description' in clean)) {
    res.status(400).json({ error: 'No editable channel fields provided' });
    return;
  }
  try {
    await database.update('conversations', conversationId, clean);
    res.status(204).send();
  } catch (error) {
    console.error(`[gateway] Update channel ${conversationId} failed:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a channel — owner only (messages.md). Non-channel conversations fall
// through to the existing generic delete behaviour.
v1.delete('/conversations/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const userId = req.user?.id;
  if (!featureFlags.isEnabled('conversations')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!conversationId || !userId) {
    res.status(400).json({ error: 'Conversation and authenticated user are required' });
    return;
  }
  const permanent = req.query.permanent === 'true';
  try {
    const result = await deleteChannel(conversationId, userId);
    switch (result.status) {
      case 'ok':
        res.status(204).send();
        return;
      case 'not_authenticated':
        res.status(401).json({ error: 'Not authenticated' });
        return;
      case 'conversation_not_found':
        res.status(404).json({ error: 'Conversation not found' });
        return;
      case 'not_channel':
        await database.delete('conversations', conversationId, permanent);
        res.status(204).send();
        return;
      case 'not_owner':
        res.status(403).json({ error: 'Only the channel owner can delete this channel' });
        return;
    }
  } catch (error) {
    console.error(`[gateway] Delete conversation ${conversationId} failed:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Edit a channel post — moderator permission (messages.md). Non-channel
// message edits keep the existing generic behaviour.
v1.put('/messages/:messageId', async (req, res) => {
  const { messageId } = req.params;
  const userId = req.user?.id;
  if (!messageId || !userId) {
    res.status(400).json({ error: 'Message and authenticated user are required' });
    return;
  }
  try {
    const gate = await evaluateChannelMessageGate(messageId, userId);
    if (gate.status === 'message_not_found') {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (gate.status === 'not_authorized') {
      res.status(403).json({ error: 'Only the channel owner or moderators can edit channel posts' });
      return;
    }
    if (gate.channel) {
      const clean = stripNonEditable((req.body as Record<string, unknown>) ?? {});
      if (Object.keys(clean).length === 0) {
        res.status(400).json({ error: 'No editable channel post fields provided' });
        return;
      }
      const result = await database.update('messages', messageId, clean);
      res.status(200).json(result);
      return;
    }
    const result = await database.update('messages', messageId, req.body);
    res.status(200).json(result);
  } catch (error) {
    console.error(`[gateway] PUT /api/v1/messages/${messageId} failed:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a channel post — moderator permission (messages.md); the post author
// keeps the right to delete their own post. Non-channel messages keep the
// existing generic behaviour.
v1.delete('/messages/:messageId', async (req, res) => {
  const { messageId } = req.params;
  const userId = req.user?.id;
  if (!messageId || !userId) {
    res.status(400).json({ error: 'Message and authenticated user are required' });
    return;
  }
  const permanent = req.query.permanent === 'true';
  try {
    const gate = await evaluateChannelMessageGate(messageId, userId);
    if (gate.status === 'message_not_found') {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (gate.status === 'not_authorized') {
      res.status(403).json({ error: 'Only the channel owner or moderators can delete channel posts' });
      return;
    }
    await database.delete('messages', messageId, permanent);
    res.status(204).send();
  } catch (error) {
    console.error(`[gateway] DELETE /api/v1/messages/${messageId} failed:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

v1.post('/:domain', validation.validateDomainMiddleware, async (req, res) => {
  const { domain } = req.params;
  if (!featureFlags.isEnabled(domain)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const groupMemberDenied = groupMemberWriteDenied(domain);
  if (groupMemberDenied) {
    res.status(403).json({ error: groupMemberDenied });
    return;
  }
  try {
    await maybeClassifyMessageRequest(domain, req.body);
    const denied = await enforceMessageWritePolicy(domain, req.user?.id, req.body);
    if (denied) {
      res.status(403).json({ error: denied });
      return;
    }
    const pinDenied = await enforcePinWritePolicy(domain, req.user?.id, req.body);
    if (pinDenied) {
      res.status(403).json({ error: pinDenied });
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
    // Scheduled posts are private to their author (see scheduledPostPrivacy).
    if (domain === 'posts' && isForeignScheduledPost(result, req.user?.id)) {
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
  // Group settings/rules/cover are owner-authorized by the dedicated /groups
  // routes above. The generic service-role update performs no authorization, so
  // it is refused for `groups` to prevent bypassing that check.
  if (domain === 'groups') {
    res.status(403).json({ error: 'Group settings must be updated via the authorized /api/v1/groups endpoints' });
    return;
  }
  const groupMemberUpdateDenied = groupMemberWriteDenied(domain);
  if (groupMemberUpdateDenied) {
    res.status(403).json({ error: groupMemberUpdateDenied });
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
  // Unpinning is a moderator permission in channels (messages.md) — a follower
  // must not be able to remove a pinned channel post by id.
  if (domain === 'pinned_messages') {
    const pinGate = await evaluatePinDeletePolicy(req.user?.id, { id });
    if (pinGate.status === 'not_authorized') {
      res.status(403).json({ error: 'Only the channel owner or moderators can unpin messages' });
      return;
    }
  }
  // A member could otherwise delete another member's membership/share row
  // directly through the service-role delete (RLS is bypassed).
  const groupMemberDeleteDenied = groupMemberWriteDenied(domain);
  if (groupMemberDeleteDenied) {
    res.status(403).json({ error: groupMemberDeleteDenied });
    return;
  }
  // A viewer must never remove another user's story reaction/view row through
  // the generic service-role delete (do.md privacy).
  if ((domain === 'story_reactions' || domain === 'story_views') && !(await isOwnedDeletableStoryRow(domain, id, req.user?.id))) {
    res.status(403).json({ error: 'You can only delete your own story reaction or view rows' });
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
  // Bulk deletes bypass RLS with the service role, so member/share rows could
  // otherwise be removed without any member-moderation authorization.
  const groupMemberBulkDeleteDenied = groupMemberWriteDenied(domain);
  if (groupMemberBulkDeleteDenied) {
    res.status(403).json({ error: groupMemberBulkDeleteDenied });
    return;
  }
  const filters = req.query.filter as string[] | string | undefined;
  const permanent = req.query.permanent === 'true';
  if (!filters) {
    res.status(400).json({ error: 'No filters provided' });
    return;
  }
  // Bulk unpin is the same moderator-scoped action: a follower must not be able
  // to remove pinned channel posts through the filter delete route.
  if (domain === 'pinned_messages') {
    const rendered = filters as string[];
    const kv = (col: string): string | undefined => {
      for (const f of rendered) {
        const eqIdx = f.indexOf('=');
        if (eqIdx === -1) continue;
        if (f.slice(0, eqIdx) !== col) continue;
        const rest = f.slice(eqIdx + 1);
        const dotIdx = rest.indexOf('.');
        if (dotIdx === -1) continue;
        return rest.slice(dotIdx + 1);
      }
      return undefined;
    };
    const pinGate = await evaluatePinDeletePolicy(req.user?.id, {
      conversationId: kv('conversation_id'),
      messageId: kv('message_id'),
      id: kv('id'),
    });
    if (pinGate.status === 'not_authorized') {
      res.status(403).json({ error: 'Only the channel owner or moderators can unpin messages' });
      return;
    }
  }
  try {
    const readableProjects = projectManager.getReadableProjects(domain);
    for (const entry of readableProjects) {
      try {
        let query = entry.client.from(domain).select('*');
        query = applySupabaseFilters(query, filters);
        const { data } = await query;
        if (data && (data as any[]).length > 0) {
          // Story reaction/view rows may only be deleted by their author; the
          // generic service-role bulk delete bypasses RLS, so unowned rows are
          // dropped before deletion (do.md privacy).
          let deletable = data as any[];
          if (domain === 'story_reactions' || domain === 'story_views') {
            const requesterId = req.user?.id;
            if (!requesterId) {
              res.status(403).json({ error: 'You can only delete your own story reaction or view rows' });
              return;
            }
            deletable = deletable.filter((row) => (row?.user_id || row?.viewer_id) === requesterId);
          }
          for (const row of deletable) {
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

// Remove a channel member — gateway-owned (messages.md).
// Only the channel owner may remove followers/moderators. The Gateway verifies
// the caller is the channel owner (conversations.created_by) before deleting
// the target's participant row. The owner and the caller cannot be removed.
// Self-removal must use the Leave channel (unfollow_channel) path instead.
v1.delete('/conversations/:conversationId/members/:memberId', async (req, res) => {
  const { conversationId, memberId } = req.params;
  const userId = req.user?.id;
  if (!conversationId || !memberId || !userId) {
    res.status(400).json({ error: 'Conversation, member, and authenticated user are required' });
    return;
  }
  try {
    const result = await removeChannelMember(conversationId, memberId, userId);
    switch (result.status) {
      case 'ok':
        res.status(204).send();
        return;
      case 'not_member':
        res.status(404).json({ error: 'You are not a participant of this conversation' });
        return;
      case 'not_channel':
        res.status(400).json({ error: 'Only channel members can be managed this way' });
        return;
      case 'not_owner':
        res.status(403).json({ error: 'Only the channel owner can remove members' });
        return;
      case 'target_is_moderator':
        res.status(403).json({ error: 'Only the channel owner can remove moderators' });
        return;
      case 'owner_protected':
        res.status(403).json({ error: 'The channel owner cannot be removed' });
        return;
      case 'self_removal':
        res.status(400).json({ error: 'You cannot remove yourself; use Leave channel instead' });
        return;
      case 'member_not_found':
        res.status(404).json({ error: 'Member is not a participant of this channel' });
        return;
    }
  } catch (error) {
    console.error(`[gateway] Remove channel member ${conversationId}/${memberId} failed:`, error);
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

// Standalone-Group member management is authorization-enforced by the dedicated
// /api/v1/groups/:groupId/... routes above. The generic service-role write
// routes perform no authorization, so they are refused for the tables dominated
// by those routes to prevent bypassing the member/moderation checks (e.g. a
// banned user re-adding themselves, a random user sharing posts into a group
// they do not belong to, or a member deleting someone else's membership row).
const GROUP_MEMBER_WRITE_DOMAINS = new Set([
  'group_members',
  'group_posts',
  'group_member_bans',
  'group_member_restrictions',
  'group_moderation_actions',
  'group_reports',
]);

function groupMemberWriteDenied(domain: string): string | null {
  if (!GROUP_MEMBER_WRITE_DOMAINS.has(domain)) return null;
  return 'Group members must be managed via the authorized /api/v1/groups/:groupId endpoints';
}

// A story_reactions row is owned by `user_id`; a story_views row by `viewer_id`.
async function isOwnedDeletableStoryRow(
  domain: string,
  id: string,
  requesterId: string | undefined
): Promise<boolean> {
  if (!requesterId) return false;
  try {
    const row = await database.read(domain, id);
    if (!row) return false;
    const ownerColumn = domain === 'story_reactions' ? 'user_id' : 'viewer_id';
    return (row as Record<string, unknown>)?.[ownerColumn] === requesterId;
  } catch {
    return false;
  }
}

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

// Pin/unpin is a moderator permission in channels (messages.md). The generic
// `pinned_messages` insert route ran with a service-key client that ignores
// RLS, so a follower could pin any channel post by calling the gateway
// directly. The pinned_by field is always taken from the verified token, never
// from the client body. Pins in DM/group conversations keep the generic
// behaviour.
async function enforcePinWritePolicy(
  domain: string,
  userId: string | undefined,
  body: unknown
): Promise<string | null> {
  if (domain !== 'pinned_messages' || !userId) return null;
  const rows = (Array.isArray(body) ? body : [body]) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  for (const row of rows) {
    if ('pinned_by' in row && row['pinned_by'] !== userId) {
      return 'pinned_by does not match authenticated user';
    }
    row['pinned_by'] = userId;
  }
  const conversationId = rows[0]['conversation_id'];
  if (typeof conversationId !== 'string') return null;
  const gate = await evaluatePinPolicy(conversationId, userId);
  if (gate.status === 'not_authorized') return 'Only the channel owner or moderators can pin messages';
  return null;
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

// The DB get_channel_members function uses auth.uid(), which is NULL on the
// conversations host (it does not share the users JWT secret), so the proxied
// call cannot resolve the caller's membership there and errors for every
// requester. Following the resolveChannelUserRole precedent, compute the member
// list gateway-side from conversation_participants (conversations host) and
// enrich the profile fields from the users host, returning the exact response
// shape the DB function produced. Returns null when the caller is not a member
// of the channel (the DB RAISE case).
async function resolveChannelMembers(
  userId: string | undefined,
  body: Record<string, unknown>
): Promise<Array<Record<string, unknown>> | null> {
  const conversationId = body && typeof body['p_conversation_id'] === 'string'
    ? (body['p_conversation_id'] as string)
    : null;
  if (!conversationId || !userId) return null;
  for (const entry of projectManager.getReadableProjects('conversations')) {
    try {
      const { data: conv } = await entry.client
        .from('conversations')
        .select('type, created_by')
        .eq('id', conversationId)
        .maybeSingle();
      if (!conv) return [];
      const { type, created_by } = conv as { type?: string | null; created_by?: string | null };
      if (type !== 'channel') return [];
      const { data: participants } = await entry.client
        .from('conversation_participants')
        .select('user_id, role, joined_at')
        .eq('conversation_id', conversationId);
      const memberRows = (participants as Array<Record<string, unknown>>) || [];
      // Mirror the DB function's participant gate: the caller (or the channel
      // creator) must be in the member list — otherwise the call is a 403.
      const isOwner = created_by === userId;
      const isParticipant = memberRows.some((r) => r['user_id'] === userId);
      if (!isOwner && !isParticipant) return null;
      const profiles = projectManager.getReadableProjects('profiles');
      const profileClient = profiles[0]?.client;
      const ids = memberRows
        .map((r) => r['user_id'])
        .filter((id): id is string => typeof id === 'string');
      const byId = new Map<string, Record<string, unknown>>();
      if (profileClient && ids.length > 0) {
        const { data: profRows } = await profileClient
          .from('profiles')
          .select('id, username, display_name, profile_pic')
          .in('id', ids);
        for (const p of (profRows as Array<Record<string, unknown>>) || []) {
          byId.set(String(p['id']), p);
        }
      }
      const out = memberRows.map((r) => {
        const uid = r['user_id'];
        const p = typeof uid === 'string' ? byId.get(uid) : undefined;
        return {
          user_id: uid,
          username: p?.username ?? null,
          display_name: p?.display_name ?? 'Unknown',
          profile_pic: p?.profile_pic ?? null,
          role: r['role'] ?? null,
          joined_at: r['joined_at'] ?? null,
        };
      });
      const rank = (role: unknown): number => role === 'owner' ? 0 : role === 'moderator' ? 1 : role === 'follower' ? 2 : 3;
      out.sort((a, b) => rank(a.role) - rank(b.role) || String(a.display_name).localeCompare(String(b.display_name)));
      return out;
    } catch {
      // Try the next readable project.
    }
  }
  return [];
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
      // The conversations-host variant may return the member id under either
      // `id` or `user_id`; normalize all rows to `user_id` so the client
      // contract is stable regardless of which column the function emits.
      const ids = rows
        .map((r) => (typeof r['user_id'] === 'string' ? r['user_id'] : r['id']))
        .filter((uid): uid is string => typeof uid === 'string');
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
        const uid = typeof row['user_id'] === 'string' ? row['user_id'] : row['id'];
        if (typeof uid !== 'string') continue;
        row['user_id'] = uid;
        const p = byId.get(uid);
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

    // Story self-replies must be impossible: the owner cannot open a
    // conversation with themselves through the Story reply system (do.md
    // section 3 / Scenario G). get_or_create_dm is the entry point the Story
    // reply flow uses to create the conversation.
    if (rpcName === 'get_or_create_dm') {
      const rpcBody = body as Record<string, unknown>;
      const userA = typeof rpcBody['p_user_a'] === 'string' ? (rpcBody['p_user_a'] as string) : undefined;
      const userB = typeof rpcBody['p_user_b'] === 'string' ? (rpcBody['p_user_b'] as string) : undefined;
      if (userA && userB && userA === userB) {
        res.status(403).json({ error: 'You cannot create a conversation with yourself' });
        return;
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

    // get_channel_members hits the same auth.uid() wall on the conversations
    // host, so it is computed gateway-side too (see resolveChannelMembers):
    // conversation_participants from the conversations host + profile
    // enrichment from the users host, mirroring the DB function's response.
    if (rpcName === 'get_channel_members') {
      const members = await resolveChannelMembers(req.user?.id, body as Record<string, unknown>);
      if (members === null) {
        res.status(403).json({ error: 'You are not a participant of this conversation' });
        return;
      }
      res.status(200).json(members);
      return;
    }

    // add/remove_channel_moderator hit the same auth.uid() wall as the RPCs
    // above: the conversations host does not share the users JWT secret, so the
    // SECURITY DEFINER functions resolve auth.uid() = NULL — every promotion and
    // demotion failed, owner included. The gateway also injects p_caller_id,
    // which those functions do not accept, and the SPA names the target
    // p_moderator_id while the repo signature expects p_user_id. Promotions and
    // demotions are therefore applied gateway-side against conversation_participants
    // on the conversations host (see features/channelModerator.ts), so the result
    // no longer depends on what is deployed at the DB function.
    if (rpcName === 'add_channel_moderator' || rpcName === 'remove_channel_moderator') {
      const rpcBody = body as Record<string, unknown>;
      const conversationId = typeof rpcBody['p_conversation_id'] === 'string' ? rpcBody['p_conversation_id'] as string : null;
      const targetUserId = typeof rpcBody['p_moderator_id'] === 'string'
        ? rpcBody['p_moderator_id'] as string
        : typeof rpcBody['p_user_id'] === 'string' ? rpcBody['p_user_id'] as string : null;
      const addVerb = rpcName === 'add_channel_moderator';
      const result = addVerb
        ? await addChannelModerator(conversationId, targetUserId, req.user?.id)
        : await removeChannelModerator(conversationId, targetUserId, req.user?.id);
      switch (result.status) {
        case 'ok':
          res.status(200).json(null);
          return;
        case 'not_authenticated':
          res.status(401).json({ error: 'Not authenticated' });
          return;
        case 'target_required':
          res.status(400).json({ error: 'Moderator target is required' });
          return;
        case 'conversation_not_found':
          res.status(404).json({ error: 'Conversation not found' });
          return;
        case 'not_channel':
          res.status(400).json({ error: 'Not a channel conversation' });
          return;
        case 'not_owner':
          res.status(403).json({ error: addVerb ? 'Only the channel owner can add moderators' : 'Only the channel owner can remove moderators' });
          return;
        case 'owner_protected':
          res.status(403).json({ error: 'The channel owner cannot be promoted or demoted' });
          return;
        case 'target_not_member':
          res.status(400).json({ error: 'User is not a participant of this channel' });
          return;
        case 'target_not_moderator':
          res.status(400).json({ error: 'User is not a moderator' });
          return;
      }
    }

    // delete_channel: the deployed DB function reads auth.uid(), which is NULL
    // on the conversations host (it does not share the users JWT secret) and
    // would raise 'Not authenticated' for every caller. Computed gateway-side
    // against conversation_participants (see features/deleteChannel.ts); ONLY
    // the channel owner may delete.
    if (rpcName === 'delete_channel') {
      const rpcBody = body as Record<string, unknown>;
      const conversationId = typeof rpcBody['p_conversation_id'] === 'string' ? rpcBody['p_conversation_id'] as string : null;
      const result = await deleteChannel(conversationId, req.user?.id);
      switch (result.status) {
        case 'ok':
          res.status(200).json(null);
          return;
        case 'not_authenticated':
          res.status(401).json({ error: 'Not authenticated' });
          return;
        case 'conversation_not_found':
          res.status(404).json({ error: 'Conversation not found' });
          return;
        case 'not_channel':
          res.status(400).json({ error: 'Not a channel conversation' });
          return;
        case 'not_owner':
          res.status(403).json({ error: 'Only the channel owner can delete the channel' });
          return;
      }
    }

    // add_channel_follower: same auth.uid() wall on the conversations host, and
    // the SPA sends p_new_follower_id while the repo signature names it
    // p_new_follower_id yet the gateway injected p_user_id (which the function
    // does not accept). Computed gateway-side (see
    // features/addChannelFollower.ts); only the owner/moderators may add
    // followers, and adding an existing member never downgrades them.
    if (rpcName === 'add_channel_follower') {
      const rpcBody = body as Record<string, unknown>;
      const conversationId = typeof rpcBody['p_conversation_id'] === 'string' ? rpcBody['p_conversation_id'] as string : null;
      const targetUserId = typeof rpcBody['p_new_follower_id'] === 'string' ? rpcBody['p_new_follower_id'] as string : null;
      const result = await addChannelFollower(conversationId, targetUserId, req.user?.id);
      switch (result.status) {
        case 'ok':
          res.status(200).json(null);
          return;
        case 'not_authenticated':
          res.status(401).json({ error: 'Not authenticated' });
          return;
        case 'target_required':
          res.status(400).json({ error: 'Follower target is required' });
          return;
        case 'conversation_not_found':
          res.status(404).json({ error: 'Conversation not found' });
          return;
        case 'not_channel':
          res.status(400).json({ error: 'Can only add followers to channel conversations' });
          return;
        case 'not_member':
          res.status(403).json({ error: 'You are not a participant of this conversation' });
          return;
        case 'not_authorized':
          res.status(403).json({ error: 'Only the channel owner or moderators can add followers' });
          return;
        case 'target_not_found':
          res.status(400).json({ error: 'User does not exist' });
          return;
      }
    }

    // get_channel_stats is a moderator-scoped read (messages.md): a follower
    // must NOT be able to view channel statistics. The owner/moderator call is
    // answered gateway-side from conversation_participants (matching the Members
    // list) instead of proxying the conversations-host DB function, which counts
    // a stale owner `follower` row and cannot resolve owner_name cross-host.
    if (rpcName === 'get_channel_stats') {
      const rpcBody = body as Record<string, unknown>;
      const conversationId = typeof rpcBody['p_conversation_id'] === 'string' ? rpcBody['p_conversation_id'] as string : null;
      const statsCtx = await resolveChannelContext(conversationId, req.user?.id);
      if (!statsCtx) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      if (!isChannel(statsCtx)) {
        res.status(400).json({ error: 'Not a channel conversation' });
        return;
      }
      if (!isOwnerOf(statsCtx, req.user?.id) && !isModeratorOf(statsCtx, req.user?.id)) {
        res.status(403).json({ error: 'Only the channel owner or moderators can view channel statistics' });
        return;
      }
      res.status(200).json(await computeChannelStats(statsCtx));
      return;
    }

    // get_people_you_may_know: the historical DB function joins `profiles`
    // (profiles host) with `blocks` (blocking host), which the RPC proxy cannot
    // satisfy (it proxies to one project). Computed gateway-side instead (see
    // features/peopleYouMayKnow.ts): candidate generation, privacy/block
    // filtering, deterministic scoring, diversity and the response shape are
    // all owned here, with the authenticated caller id (never the client body).
    if (rpcName === 'get_people_you_may_know') {
      const rpcBody = body as Record<string, unknown>;
      const requestedLimit = typeof rpcBody['p_limit'] === 'number' ? (rpcBody['p_limit'] as number) : undefined;
      const rows = await computePeopleYouMayKnow(req.user?.id, { limit: requestedLimit });
      res.status(200).json(rows);
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
// Cloudinary signed-upload handoff: Vercel caps serverless request bodies
// (~4.5MB on Hobby) at the platform layer before the function runs, so a
// proxied multipart video upload aborts mid-stream and the browser surfaces
// TypeError: Failed to fetch. Instead the client asks the gateway for a signed
// Cloudinary upload URL, then POSTs the file straight to Cloudinary.
router.post('/storage/sign', auth.authenticate.bind(auth), async (req: Request, res: Response) => {
  const { bucket, path } = req.body || {};
  if (!bucket || !path) {
    res.status(400).json({ error: 'bucket and path are required' });
    return;
  }
  try {
    const signed = await storage.createSignedUpload({ bucket, path });
    res.status(200).json(signed);
  } catch (error) {
    console.error('[Gateway] Storage signing failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to sign upload' });
  }
});

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
// `?format=mp3` (etc.) adds a Cloudinary on-delivery format conversion to the
// redirect target — the voice-message client uses it to play legacy WebM/Opus
// recordings in browsers without a WebM decoder (Safari/iOS).
router.get('/storage/:bucket/*', async (req: Request, res: Response) => {
  const { bucket } = req.params;
  const path = req.params[0];
  if (!bucket || !path) {
    res.status(400).json({ error: 'bucket and path are required' });
    return;
  }
  const format = typeof req.query.format === 'string' ? req.query.format : undefined;
  try {
    const resolved = await storage.resolvePublicUrl(path, format);
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
  // Group creation must go through POST /api/v1/groups so the Gateway validates
  // name/privacy and stamps the owner itself; the generic insert skips both.
  if (domain === 'groups') {
    res.status(403).json({ error: 'Group creation must use POST /api/v1/groups' });
    return;
  }
  const groupMemberCreateDenied = groupMemberWriteDenied(domain);
  if (groupMemberCreateDenied) {
    res.status(403).json({ error: groupMemberCreateDenied });
    return;
  }
  try {
    await maybeClassifyMessageRequest(domain, req.body);
    const denied = await enforceMessageWritePolicy(domain, req.user?.id, req.body);
    if (denied) {
      res.status(403).json({ error: denied });
      return;
    }
    const pinDenied = await enforcePinWritePolicy(domain, req.user?.id, req.body);
    if (pinDenied) {
      res.status(403).json({ error: pinDenied });
      return;
    }
    // Story privacy (do.md): the Story owner must NOT be able to create a
    // reaction on their own Story (Scenario F), and reaction/view rows are
    // always stamped with the authenticated caller so no client can attribute
    // a reaction or a view to another user.
    if (domain === 'story_reactions') {
      const reactionDenied = await storyReactionWriteDenied(
        req.body,
        projectManager.getReadableProjects('stories').map((p) => p.client),
        req.user?.id
      );
      if (reactionDenied) {
        res.status(403).json({ error: reactionDenied });
        return;
      }
      if (req.user?.id && req.body && typeof req.body === 'object') {
        (req.body as Record<string, unknown>).user_id = req.user.id;
      }
    }
    if (domain === 'story_views' && req.user?.id && req.body && typeof req.body === 'object') {
      (req.body as Record<string, unknown>).viewer_id = req.user.id;
    }
    // Re-recording an already recorded view (unique story_id + viewer_id) is
    // not an error: the view simply stays counted once.
    let result: Awaited<ReturnType<typeof database.write>> | null;
    try {
      result = await database.write(domain, req.body);
    } catch (writeError) {
      if (domain === 'story_views' && /duplicate key/i.test(String((writeError as Error).message))) {
        result = null;
      } else {
        throw writeError;
      }
    }
    // Views are counted from `story_views` (independent of reactions) and the
    // total is stored gateway-side, so no viewer ever reads another user's
    // view rows/counts (do.md sections 5/6/8).
    if (domain === 'story_views') {
      await bumpStoryViewsCount(projectManager.getWritableProject('story_views')?.client, result);
    }
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
          // Story privacy (do.md): the generic service-role read bypasses RLS,
          // so per-row restrictions run here so a non-owner viewer receives
          // ONLY their own reaction state (story_reactions), Story views are
          // owner-only (story_views), and view analytics on `stories` rows
          // (views count + viewed_by ids) never reach a non-owner.
          if (domain === 'story_reactions') {
            rows = await restrictStoryReactionsRead(rows, entry.client, requesterId);
          } else if (domain === 'story_views') {
            rows = await restrictStoryViewsRead(rows, entry.client, requesterId);
          } else if (domain === 'stories') {
            rows = restrictStoryRowsRead(rows, requesterId);
          }
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
    res.json(domain === 'posts' ? filterScheduledPosts(results.flat(), requesterId) : results.flat());
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
    // A scheduled post belongs to its author alone; resolve any other user's
    // scheduled post the same way as a missing row so a single-row read
    // cannot leak it.
    if (domain === 'posts' && isForeignScheduledPost(result, req.user?.id)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // Story rows carry view analytics; a non-owner must not receive them even
    // through a single-row read (do.md scenario H).
    if (domain === 'stories') {
      res.json(restrictStoryRowsRead([result], req.user?.id)[0]);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router };
