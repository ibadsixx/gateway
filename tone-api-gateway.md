# Tone API Gateway

Base URL: `https://gateway-iota-two.vercel.app`

The API Gateway is the single entry point for all Tone ecosystem databases. Each request is routed to the correct backend project based on the **domain** in the URL path.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Security Audit](#security-audit)
- [Quick Start](#quick-start)
- [Routes Overview](#routes-overview)
- [Domains & Projects](#domains--projects)
- [API Reference](#api-reference)
  - [Create Record](#create-record)
  - [Read Record](#read-record)
  - [Update Record](#update-record)
  - [Delete Record](#delete-record)
- [Domain Schemas](#domain-schemas)
  - [posts](#posts)
  - [comments](#comments)
  - [stories](#stories)
  - [notifications](#notifications)
  - [pages](#pages)
  - [conversations](#conversations)
  - [hashtags](#hashtags)
  - [advertisers](#advertisers)
- [System Endpoints](#system-endpoints)
- [Realtime Endpoints (SSE)](#realtime-endpoints-sse)
- [Bugs](#bugs)
- [Known Limitations](#known-limitations)
- [Direct Database Access (Deprecated)](#direct-database-access-deprecated)
- [cURL Cheat Sheet](#curl-cheat-sheet)
- [Recommendations](#recommendations-priority-order)

---

## How It Works

```
Client App
    │
    ▼
┌──────────────────────────┐
│   API Gateway            │
│   /api/:domain           │
│   /api/v1/:domain/:id    │
└──────────┬───────────────┘
           │
     Routes to the correct backend project
           │
    ┌──────┼──────┬──────┬──────┐
    ▼      ▼      ▼      ▼      ▼
 posts   comments stories  ...  pages
 (Backend #1) (Backend #2) ...
```

The gateway reads the `domain` parameter from the URL (e.g., `posts`, `comments`, `stories`) and routes the request to the matching backend project. The application and control panel do **not** need to manage database connections -- just call the gateway.

---

## Architecture

### Module Map

| Layer | File | Description |
|-------|------|-------------|
| Entry (Vercel) | `api/[...slug].ts:1-93` | Vercel serverless handler; creates Express app, initializes all services |
| Entry (Dev) | `src/dev.ts:1-89` | Local dev server |
| Routes | `src/api/routes.ts:1-445` | All API routes (v1 + system + top-level + `/api/rpc/:function`) |
| Middleware | `src/api/middleware.ts:1-64` | CORS, body parsing, rate limiting, audit logging, metrics |
| Auth | `src/auth/index.ts`, `src/api/auth.ts` | JWT verification, admin auth, sign-up/login |
| Routing | `src/routing/router.ts`, `src/routing/service.ts`, `src/routing/locator.ts` | Domain-based routing with hash sharding |
| Registry | `src/registry/databaseRegistry.ts`, `src/registry/projectRegistry.ts`, `src/registry/storageRegistry.ts` | Dynamic project/provider management |
| Infrastructure DB | `src/infrastructure/database/infrastructureDb.ts` (520 lines) | Backend-backed config with in-memory fallback |
| Project Manager | `src/project-manager/index.ts` | Project lifecycle management |
| Circuit Breaker | `src/circuit-breaker/index.ts` | 3-state fault isolation (CLOSED/OPEN/HALF_OPEN) |
| Retry Engine | `src/retry/engine.ts` | Exponential backoff + jitter |
| Config | `src/config/index.ts` | Dynamic configuration via backend |
| Providers | `src/providers/database/`, `src/providers/storage/` | Database/storage adapters (all stubs) |
| Events | `src/events/bus.ts` | Internal event system |
| Monitoring | `src/infrastructure/monitoring/index.ts` | Health checks and metrics |
| Audit | `src/audit/index.ts` | Request audit logging |
| Rate Limiting | `src/rate-limiting/index.ts` | Per-domain rate limits |
| Features | `src/features/index.ts` | Feature flags |
| Permissions | `src/permissions/index.ts` | Permission engine |
| Jobs | `src/jobs/queue.ts` | Background job queue |
| Notifications | `src/notifications/index.ts` | Notification delivery |
| Search | `src/search/index.ts` | Search index |
| Media | `src/media/contentAddress.ts` | SHA-256 content dedup |
| Locking | `src/locking/index.ts` | Distributed locks (in-memory) |
| Validation | `src/api/validation.ts` | Domain name validation |
| Realtime (SSE) | `src/realtime/channelHub.ts`, `src/api/realtime.ts` | In-memory SSE fan-out hub + realtime/ICE routes (added Aug 14, 2026) |

### Data Flow

```
Client Request
    │
    ▼
┌─────────────────────────────────────────────┐
│  Middleware (CORS, body parsing, rate limit) │
│  src/api/middleware.ts                       │
└──────────┬──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  Router (domain extraction, auth, routing)   │
│  src/api/routes.ts → src/routing/router.ts   │
└──────────┬──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  Registry Lookup (domain → project mapping)  │
│  src/registry/databaseRegistry.ts            │
└──────────┬──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  Infrastructure DB (backend or in-memory)   │
│  src/infrastructure/database/                │
│  infrastructureDb.ts                         │
└──────────┬──────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  Circuit Breaker → Retry Engine → Provider   │
│  src/circuit-breaker/ → src/retry/ →         │
│  src/providers/database/                     │
└──────────┬──────────────────────────────────┘
           │
           ▼
    Backend Project (per domain)
```

### In-Memory State

All state is held in memory and lost on Vercel cold starts:

| Service | File | Impact |
|---------|------|--------|
| Rate limit counters | `src/rate-limiting/index.ts:7` | Limits reset on cold start |
| Audit logs | `src/audit/index.ts:14` | Request history lost |
| Metrics | `src/infrastructure/monitoring/index.ts` | Metrics reset |
| Feature flags | `src/features/index.ts:2` | Flag state lost |
| Permissions | `src/permissions/index.ts:11` | Permission assignments lost |
| Search index | `src/search/index.ts:15` | Index cleared |
| Content dedup cache | `src/media/contentAddress.ts:4` | Dedup cache cleared |
| Distributed locks | `src/locking/index.ts:9` | Locks released |
| Job queue | `src/jobs/queue.ts` | Pending jobs lost |
| Notification queue | `src/notifications/index.ts` | Pending notifications lost |

**Note:** The `DistributedLock` class (`src/locking/index.ts:1`) uses an in-memory `Map` and is not actually distributed across Vercel function instances.

---

## Security Audit

### Critical

| # | Issue | File | Impact | Status |
|---|-------|------|--------|--------|
| 1 | ~~**Hardcoded Supabase `service_role` keys in committed code**~~ | `src/infrastructure/database/infrastructureDb.ts:483-485` | ~~Real `service_role` keys in fallback data, committed to git. These bypass all RLS policies. Anyone with repo access has full database access.~~ | **FIXED** — Keys now retrieved from `process.env.INFRA_SUPABASE_URL` and `process.env.INFRA_SUPABASE_KEY` |
| 2 | **`.env` with `INFRA_SUPABASE_KEY` in working tree** | `gateway/.env` | Same service_role key accessible; `.gitignore` excludes `.env` but it was committed before the rule was added. The deployment reads `INFRA_SUPABASE_URL`/`INFRA_SUPABASE_KEY` from Vercel env vars; the local file still holds a key and should be purged/rotated (see P0 #1). | Open |
| 3 | ~~**`/api/system/databases` exposes all service keys**~~ | `src/api/routes.ts:242` | ~~Returned all Supabase project URLs and service_role keys to any caller. No authentication required. Full database takeover possible.~~ **FIXED (Aug 2026)** — Endpoint removed from source; code comment notes it exposed service keys publicly. |
| 4 | **System endpoints admin-gated but dead** | `src/api/routes.ts:235` | All `/api/system/*` endpoints except `/health` now require `authenticateAdmin`, so they are no longer publicly accessible. However `ADMIN_API_KEY` is never set, so they always return 503 ("Admin access not configured"). | Open |

### High

| # | Issue | File | Impact |
|---|-------|------|--------|
| 5 | **CORS reflects any origin** | `src/api/middleware.ts:14` | `cors({ origin: true })` when `CORS_ORIGINS` is unset — effectively disables CORS protection. CSRF and data exfiltration possible. |
| 6 | **Auth verification not domain-scoped** | `src/auth/index.ts:158-194` | `getAuthCredentials(domain)` does filter by domain (`.eq('domain', domain)`, line 50) and caches per-domain, but `getSupabaseClient()`/`getAnonClient()`/`verifyViaSupabase()` call it with no argument and default to `'users'` — so the JWT `getUser()` fallback always verifies against the `users` project's credentials, not the requested domain's. |
| 7 | **`ADMIN_API_KEY` never defined in `.env`** | `src/auth/index.ts:205` | Admin auth system is dead code — always returns 503 ("Admin access not configured"). |
| 8 | **`constantTimeCompare` leaks length** | `src/auth/index.ts:78-83` | Early return on length mismatch defeats timing-safe comparison. Attacker can determine admin key length before brute-force. |
| 9 | **JWT fallback bypass** | `src/auth/index.ts:151` | Falls back to Supabase `getUser()` on signature mismatch — forged token with valid structure gets a second chance via API. |

### Medium

| # | Issue | File | Impact |
|---|-------|------|--------|
| 10 | **Health check leaks server info** | `src/api/routes.ts:226-232` | Exposes `uptime` (server start time) + `X-Gateway` header — fingerprinting data for attackers. |
| 11 | **Sign-up auto-confirms email** | `src/api/auth.ts` | Unlimited account creation spam possible. |
| 12 | **No rate limiting on admin endpoints** | `src/api/routes.ts:235` | Admin auth could be brute-forced (1000 req/min via general rate limit). |

---

## Bugs

| # | Issue | File | Severity | Status |
|---|-------|------|----------|--------|
| 1 | **Monitoring health check uses random values** | `src/infrastructure/monitoring/index.ts:28` | `Math.random() * 200` as response time — all health metrics meaningless. | Open |
| 2 | **Notification infinite retry loop** | `src/notifications/index.ts:36-39` | Failed notifications re-enqueue with no backoff, retry limit, or dead-letter. CPU spin on persistent failure. | Open |
| 3 | **Circuit breaker never trips** | `src/routing/router.ts:48-62` | Failure tracking resets on project swap during retry — breaker keyed on old project ID. | Open |
| 4 | **`generateId` not collision-resistant** | `src/utils/index.ts:1-5` | Uses `Math.random()` — multiple calls in same millisecond across Vercel instances can collide. | Open |
| 5 | **Provider fallback picks wrong provider** | `src/registry/databaseRegistry.ts:84-85` | Falls back to first provider of matching type if name doesn't match — MongoDB project could register under Supabase. | Open |
| 6 | **`toDbStatus` missing default case** | `src/registry/databaseRegistry.ts:35-42` | Switch may not return a value in all code paths. | Open |
| 7 | **Job queue single-threaded** | `src/jobs/queue.ts:54-58` | Concurrent `processNext()` calls silently return; jobs enqueued during processing may not run. | Open |
| 8 | **`api/[...slug].ts` duplicates `src/dev.ts`** | `api/[...slug].ts:25-75` | Entire initialization sequence copied between files. | Open |
| 9 | **Top-level routes duplicate v1 routes** | `src/api/routes.ts:292-354` | CRUD routes registered twice with minor differences. | Open |
| 10 | ~~**Gateway client `ReferenceError: row is not defined`**~~ | `src/lib/gateway.ts:80` | ~~`row` variable referenced outside its scope in `applyFilters`.~~ | **FIXED** — Arrow function + simplified negation logic |
| 11 | ~~**Gateway client column selection broken with nested joins**~~ | `src/lib/gateway.ts:326-340` | ~~Complex select strings with PostgREST nested joins (e.g., `group_members!...(...)`) caused `parseSelect` to return partial columns.~~ | **FIXED** — `parseSelectColumns()` + `hasNestedJoins()` helpers added |
| 12 | ~~**Gateway client join cardinality inverted**~~ | `src/lib/gateway.ts:183-227` | ~~To-one embedded joins (`!fk`, `:alias` on an `_id`/FK column) resolved as arrays — `post.profiles` was an array, so `profiles?.display_name` was `undefined` ("Unknown" author names in the feed).~~ | **FIXED** — `JoinSpec` now carries `kind: 'one' | 'many'` (line 189); `effectiveIsArray = kind === 'many'` (line 508) |
| 13 | ~~**Gateway client dropped the join key during column selection**~~ | `src/lib/gateway.ts:514-522` | ~~The picker kept only requested columns and stripped the `relatedCol` key column used for matching — zero rows ever matched, so the join silently produced nothing even with correct cardinality.~~ | **FIXED** — column picker always retains `spec.relatedCol` (line 516) |
| 14 | ~~**Gateway client `not.` operator serialized incorrectly**~~ | `src/lib/gateway.ts` | ~~`not()` emitted `{col}=not.{op}.{value}`, which parsed to the wrong column/operator and silently matched nothing.~~ | **FIXED (Aug 2, 2026)** — both builders emit PostgREST-correct `not.{col}={op}.{value}`; `is` now handles `null`/`true`/`false`; count joins return `[{ count }]`; bulk `.update()` without an `id=eq.` filter falls back to fetch → client-side filter → per-id `PUT /api/v1/:domain/:id` (`_bulkUpdate`) |
| 15 | ~~**Call signaling client left peers permanently "busy"**~~ | `tone-your-social-voice/src/contexts/call/CallContext.tsx`, `callTabCoordinator.ts` | ~~Three holes: a crashed tab never cleaned up the cross-tab localStorage counter, so every incoming call auto-replied busy **forever (survived reloads)**; `call-ended` published during the callee's SSE reconnect window was lost with no replay (the 300s Vercel cap guarantees this window on every call >5 min); nothing verified the local call was alive before replying busy and no callee ring timeout existed.~~ | **FIXED (Aug 21, 2026, frontend `b5c54ff`)** — counter entries heartbeat every 15s and self-clear when stale >75s (legacy values heal on load); incoming calls are accepted instead of auto-busy when the own peer connection is `failed`/`closed`; watchdog ends zombie `'connected'` calls; 45s ring timeout; `call-ended` retries twice on `delivered=0` to bridge reconnect gaps |

---

## Live Deployment Observations (July 2026)

Verified against `https://gateway-iota-two.vercel.app`:

| Endpoint | Result |
|----------|--------|
| `GET /api/system/health` | `200` healthy |
| `GET /api/system/features` | `503` "Admin access not configured" (`ADMIN_API_KEY` undefined) |
| `GET /api/posts` (no token) | `401` — data routes now require a Bearer token (`auth.authenticate` on `/:domain`) |
| `GET /api/profiles` (no token) | `401` — profiles host resolves through the gateway and answers HTTP 401 |
| `GET /api/friends` (no token) | `404 {"error":"Not found"}` — `friends` had **no registered domain** (`featureFlags.isEnabled('friends')` false); registered July 2026, enabled on next cold start |
| `POST /api/auth/sign-up` | `400 {"error":"{}"}` — GoTrue on the users project returns `500 {"code":500,"error_code":"unexpected_failure","msg":"Database error creating new user"}` (verified via the gateway infrastructure layer, Aug 4, 2026) |
| `POST /api/auth/sign-in` | `401 "Invalid login credentials"` — correct: no user was ever created because sign-up always 500s |

**Root cause (Aug 4, 2026): not a gateway bug — FIXED LIVE.** The `users` project's Auth could not create users — `INSERT INTO auth.users` was rejected by a legacy `on_auth_user_created` trigger (`handle_new_user`) inserting into `public.profiles`, which does not exist in that project (the repo migrations do create `public.profiles`, so the migration set applied to the users project diverges from the repo; live `profiles` is served by the dedicated `profiles` project). The dead trigger was dropped on the live project, so sign-up/sign-in now work through the gateway. See `sql/fix_auth_users_project.sql` for the diagnostic/repair SQL (already applied).

**Note:** the gateway source exposes `POST /api/rpc/:function` (`src/api/routes.ts:283`, mounted at `routes.ts:390`) behind `auth.authenticate`. It routes to the `users` project by default, with a single override `seed_default_ad_topics` → `ad_topics` (`RPC_DOMAIN_OVERRIDES`). Like all data routes it is unusable without a working token, so live behavior is unverified. On Aug 4, 2026 all blocking RPCs (`block_user`, `unblock_user`, `get_blocked_users`, `get_block_relation`, `get_user_blocks`, `is_blocked`, `get_blocked_user_ids`, `restrict_user`, `unrestrict_user`, `get_restricted_users`, `is_restricted`, `get_blocked_nicknames`, `add/remove_blocked_nickname`, `get/add/remove_blocked_sender`) were routed to the `blocking` project, which hosts the tables but had zero app RPC functions — see `sql/blocking_rpc_functions.sql`. The users project's old copies were dead: `get_blocked_user_ids` → `42P01 relation "blocks" does not exist`, `block_user`/`is_blocked` → `PGRST203` ambiguous overload, `get_user_blocks` → `PGRST202` not found.

### Domain Registration (July 2026)

The frontend queries ~108 tables via `gateway.from('<table>')`, which hits `GET /api/<table>`. Because the gateway is table-as-domain, every one of those tables must exist in `infrastructure_projects` or the route 404s — the app surfaced this as "Failed to load friends"/"Failed to load other names" toasts (`src/hooks/useFriends.ts:86`, `src/hooks/useOtherNames.ts:36`). ~80 of those tables had never been registered.

Fix (config-only, no gateway source changes): each missing table was probed against every registered project, then registered as a domain whose project row clones the credentials of the host project (`infrastructure_projects` + `domains` kept in sync; inserts performed via the infra DB service client, idempotent, no keys written to disk). Result: **98 of 105** frontend-queried tables now have a domain. The remaining entries were re-audited on Aug 2, 2026: 7 are tables still lacking a domain, and 3 of the original 108 (`avatars`, `covers`, `group_covers`) are storage buckets rather than tables (see [Domains & Projects](#domains--projects)).

**Caveat (fixed Aug 4, 2026, `e3ee66d`):** feature flags are only enabled from `infrastructure_projects` at gateway startup. Previously the 60s `refreshRegistry()` reloaded projects but did **not** re-enable flags, so new domains only activated on the next Vercel cold start. The periodic refresh now calls `featureFlags.enable(domain)` for every refreshed domain (`src/dev.ts`), so newly registered domains activate on the next refresh cycle without a cold start.

---

## Quick Start

> **NOTE:** All data routes (`/api/:domain`, `/api/:domain/:id`) require a `Bearer` token and return `401` without one (see [Live Deployment Observations](#live-deployment-observations-july-2026)). The examples below omit it for brevity; on the live deployment they return `401` until a token is obtained. Sign-up/sign-in now work (the Aug 4, 2026 GoTrue trigger fix, see below); admin routes still return 503 (`ADMIN_API_KEY` undefined).

### Create a Post

```bash
curl -X POST https://gateway-iota-two.vercel.app/api/posts \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "YOUR_USER_UUID",
    "content": "Hello world!",
    "type": "normal_post",
    "visibility": "public",
    "status": "published"
  }'
```

**Response (201):**
```json
{
  "id": "234164bc-1f58-42f5-95aa-747446d5ce54",
  "user_id": "YOUR_USER_UUID",
  "content": "Hello world!",
  "type": "normal_post",
  "visibility": "public",
  "status": "published",
  "created_at": "2026-07-12T09:21:27.950508+00:00",
  ...
}
```

### Read it Back

```bash
curl https://gateway-iota-two.vercel.app/api/posts/234164bc-1f58-42f5-95aa-747446d5ce54
```

### Create a Comment

```bash
curl -X POST https://gateway-iota-two.vercel.app/api/comments \
  -H "Content-Type: application/json" \
  -d '{
    "post_id": "234164bc-1f58-42f5-95aa-747446d5ce54",
    "user_id": "YOUR_USER_UUID",
    "content": "Nice post!"
  }'
```

---

## Routes Overview

| Method | Path | Description | Available At |
|--------|------|-------------|--------------|
| `POST` | `/api/:domain` | Create a record | `/api/` and `/api/v1/` |
| `GET` | `/api/:domain/:id` | Read a record | `/api/` and `/api/v1/` |
| `PUT` | `/api/v1/:domain/:id` | Update a record | `/api/v1/` only |
| `DELETE` | `/api/v1/:domain/:id` | Delete a record | `/api/v1/` only |

**Note:** `POST` and `GET` work at both `/api/` and `/api/v1/`. `PUT` and `DELETE` are only available at `/api/v1/`.

---

## Domains & Projects

The gateway is **table-as-domain**: `GET /api/:domain` routes to the project(s) registered for that domain. At startup the feature flag for a domain is only enabled if it appears in the live infra DB `infrastructure_projects` table (`api/[...slug].ts:45-49` → `projectManager.load()` → `infrastructureDb.getProjects()`); when the flag is off the route returns `404 {"error":"Not found"}` (`src/api/routes.ts:306-311`). Routing reads the same cached project rows grouped by `domain` (`project-manager/index.ts:74-102`).

**~100 domains** are currently registered across **13 backend projects** (was 12; the users-domain project is where all 230 app migrations were applied and hosts the bulk of the social-graph tables).

### Primary domains

| Domain | Host Project | Status | Description |
|--------|--------------|--------|-------------|
| `posts` | posts host | Active | Posts + `likes`, `post_shares`, `post_tags`, `reported_posts`, `saved_posts`, `shares` |
| `comments` | comments host | Active | Comments + `comment_reactions`, `comment_shares`, `reels_comments` |
| `stories` | stories host | Active | Stories + 9 `story_*` sub-domains |
| `notifications` | notifications host | Active | User notifications |
| `pages` | pages host | Active | Pages + `page_followers`, `page_posts` |
| `conversations` | conversations host | Active | Conversations + `messages`, `message_requests`, `message_reactions`, `message_reports`, `pinned_messages`, `conversation_clears`, `conversation_participants`, `conversation_reports`, `conversation_settings`, `message_reads`, `message_polls`, `message_poll_votes`, `blocked_message_senders` |
| `hashtags` | hashtags host | Active | Hashtags, follows, analytics |
| `advertisers` | advertisers host | Active | Advertisers + `ad_activity`, `ad_advertisers`, `ad_settings`, `ad_topics` |
| `music` | music host | Active | Music library (also exposed as `music_library`) |
| `blocking` | blocking host | Active | Blocking (`blocks` table + `block_*`/`get_*` RPCs routed here) |
| `profiles` | profiles host | Auth-gated | User profiles + `profile_details`, `profile_posts`, `profile_reports`. Host resolves and answers HTTP 401; data route returns 401 without a Bearer token. Reachability with a valid token unverified. |
| `groups` | groups host | Active | Groups + `group_follows`, `group_members`, `group_pins`, `group_posts` |
| `users` | users host | Active | 48 social-graph tables (see full registry below) |

### Full domain registry (from live gateway infra DB, July 2026)

- **users host (48)** — `users`, `audience_lists`, `bug_reports`, `call_history`, `colleges`, `companies`, `content_preferences`, `editor_projects`, `encryption_verifications`, `export_requests`, `family_relationships`, `followers`, `follows`, `friends`, `friendships`, `hidden_content`, `hidden_reels`, `high_schools`, `life_events`, `lives`, `locations`, `mentions`, `muted_users`, `notification_delivery_settings`, `notification_preferences`, `other_names`, `pokes`, `post_notifications`, `privacy_settings`, `reactions`, `reel_preference_signals`, `reel_reports`, `reels_activity`, `reels_likes`, `saved_ads`, `search_history`, `status_visibility`, `sticker_packs`, `stickers`, `technical_feedback`, `user_activity`, `user_ad_interactions`, `user_ad_partner_settings`, `user_contacts`, `user_device_keys`, `user_encryption_keys`, `user_feedback`, `user_preferences`
- **stories host (10)** — `stories`, `story_highlight_items`, `story_highlights`, `story_mentions`, `story_poll_votes`, `story_polls`, `story_question_responses`, `story_questions`, `story_reactions`, `story_views`
- **conversations host (14)** — `conversations`, `conversation_clears`, `conversation_participants`, `conversation_reports`, `conversation_settings`, `message_polls`, `message_poll_votes`, `message_reads`, `message_reactions`, `message_reports`, `message_requests`, `messages`, `pinned_messages`, `blocked_message_senders`
- **posts host (7)** — `posts`, `likes`, `post_shares`, `post_tags`, `reported_posts`, `saved_posts`, `shares`
- **groups host (5)** — `groups`, `group_follows`, `group_members`, `group_pins`, `group_posts`
- **advertisers host (5)** — `advertisers`, `ad_activity`, `ad_advertisers`, `ad_settings`, `ad_topics`
- **profiles host (4)** — `profiles`, `profile_details`, `profile_posts`, `profile_reports`
- **comments host (4)** — `comments`, `comment_reactions`, `comment_shares`, `reels_comments`
- **pages host (3)** — `pages`, `page_followers`, `page_posts`
- **music host (2)** — `music`, `music_library`
- **hashtags host (1)** — `hashtags`
- **blocking host (1)** — `blocking`
- **notifications host (1)** — `notifications`

### Infrastructure storage registry

Managed cloud storage accounts live in the infra DB in `infrastructure_storage` (added Aug 4, 2026). Columns: `id`, `storage_key` (unique, e.g. `cloudinary_1`), `provider_id` → `providers(id)`, `cloud_name`, `api_key`, `api_secret` (encrypted at rest), `status` (`available` | `full`), `capacity` (total bytes), `used_space` (bytes), `available_space` (generated `capacity - used_space`), `last_update` (last usage/capacity refresh), `created_at`, `updated_at`. Source of truth: `gateway/src/db/migrations/002_create_infrastructure_storage.sql`.

### Frontend-queried tables without a registered domain (7) + 3 storage buckets

Re-audited against the frontend source (Aug 2, 2026):

- **7 tables genuinely queried as tables but lacking a domain:**
  - `media_library`, `restricted_users`, `trusted_devices` — created by app migrations applied to the users project but missed by the July 2026 registration probe; still need domains.
  - `blocks` — queried via `gateway.from('blocks')`; only the `blocking` domain is registered (table/domain name mismatch).
  - `blocked_nicknames`, `hashtag_follows`, `message_audios` — not found in any registered project (may live in unregistered projects or be legacy/dead code).
- **3 are storage buckets, not tables** — `avatars`, `covers`, `group_covers` are accessed via `gateway.storage.from('...')` in the frontend and should not be registered as table domains.

---

## API Reference

### Create Record

```
POST /api/{domain}
```

Inserts a new record into the primary table of the given domain.

**Request Body:** JSON object with column values.

**Success Response:** `201 Created` with the full inserted record.

**Example -- Create a Story:**

```bash
curl -X POST https://gateway-iota-two.vercel.app/api/stories \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "YOUR_USER_UUID",
    "media_url": "https://example.com/video.mp4",
    "media_type": "video",
    "privacy": "public",
    "views": 0,
    "viewed_by": []
  }'
```

**Response (201):**
```json
{
  "id": "11759d8d-60d3-47f3-adeb-1ca95a78875c",
  "user_id": "YOUR_USER_UUID",
  "media_url": "https://example.com/video.mp4",
  "media_type": "video",
  "privacy": "public",
  "views": 0,
  "viewed_by": [],
  "created_at": "2026-07-12T09:38:28.812476+00:00",
  "expires_at": "2026-07-13T09:38:28.812476+00:00",
  ...
}
```

**Example -- Create a Notification:**

```bash
curl -X POST https://gateway-iota-two.vercel.app/api/notifications \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "TARGET_USER_UUID",
    "actor_id": "ACTOR_USER_UUID",
    "type": "like",
    "message": "liked your post",
    "is_read": false
  }'
```

**Example -- Create a Page:**

```bash
curl -X POST https://gateway-iota-two.vercel.app/api/pages \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Page",
    "admin_id": "YOUR_USER_UUID",
    "links": {},
    "legal_info": {},
    "work_education": {},
    "family_members": {},
    "archived": false
  }'
```

**Example -- Create a Conversation:**

```bash
curl -X POST https://gateway-iota-two.vercel.app/api/conversations \
  -H "Content-Type: application/json" \
  -d '{
    "type": "direct",
    "created_by": "YOUR_USER_UUID",
    "chat_theme": "default",
    "can_add_members": "true"
  }'
```

---

### Read Record

```
GET /api/{domain}/{id}
```

Fetches a single record by its UUID.

**Success Response:** `200 OK` with the record.

**Not Found:** `404` if no record matches.

**Example:**

```bash
curl https://gateway-iota-two.vercel.app/api/posts/234164bc-1f58-42f5-95aa-747446d5ce54
```

---

### Update Record

```
PUT /api/v1/{domain}/{id}
```

Updates a record by ID. Only available under the `/api/v1/` prefix.

**Request Body:** JSON object with fields to update.

**Success Response:** `200 OK` with the updated record.

**Example:**

```bash
curl -X PUT https://gateway-iota-two.vercel.app/api/v1/posts/234164bc-1f58-42f5-95aa-747446d5ce54 \
  -H "Content-Type: application/json" \
  -d '{"content": "Updated content"}'
```

---

### Delete Record

```
DELETE /api/v1/{domain}/{id}?permanent=true
```

Deletes a record by ID. Only available under the `/api/v1/` prefix.

| Parameter | Description |
|-----------|-------------|
| `?permanent=true` | Hard-deletes the record permanently |
| (no param) | Soft-deletes (sets `deletedAt` field -- only works if the table has this column) |

**Success Response:** `204 No Content`.

**Example:**

```bash
curl -X DELETE "https://gateway-iota-two.vercel.app/api/v1/posts/234164bc-1f58-42f5-95aa-747446d5ce54?permanent=true"
```

---

## Domain Schemas

### posts

**Table:** `posts` -- Main content table.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `user_id` | uuid | Yes | Author's user ID |
| `content` | text | No | Post text content |
| `media_url` | text | No | URL to media attachment |
| `type` | text | No | `normal_post`, `shared_post`, etc. (default: `normal_post`) |
| `visibility` | text | No | `public`, `private`, `friends` (default: `public`) |
| `status` | text | No | `published`, `draft`, `archived` (default: `published`) |
| `shared_post_id` | uuid | No | ID of original post if this is a share |
| `like_count` | integer | No | Like count (default: 0) |
| `comment_count` | integer | No | Comment count (default: 0) |
| `share_count` | integer | No | Share count (default: 0) |
| `audience_type` | text | No | `public`, `custom`, `specific` |
| `audience_user_ids` | uuid[] | No | Specific audience users |
| `audience_excluded_user_ids` | uuid[] | No | Excluded users |
| `feeling_activity_type` | text | No | Feeling/activity type |
| `feeling_activity_emoji` | text | No | Feeling emoji |
| `feeling_activity_text` | text | No | Feeling text |
| `scheduled_at` | timestamptz | No | Schedule for future publishing |
| `location_name` | text | No | Location name |
| `location_lat` | double | No | Latitude |
| `location_lng` | double | No | Longitude |
| `duration` | integer | No | Video/audio duration in seconds |
| `aspect_ratio` | text | No | `9:16`, `1:1`, `16:9` (default: `9:16`) |
| `media_type` | text | No | `image`, `video`, `audio` |
| `music_url` | text | No | Background music URL |
| `music_title` | text | No | Music title |
| `music_artist` | text | No | Music artist |
| `music_start` | integer | No | Music start offset (default: 0) |
| `thumbnail` | text | No | Thumbnail URL |
| `alt_text` | text | No | Accessibility alt text |
| `ai_label` | boolean | No | AI-generated label (default: false) |
| `comments_enabled` | boolean | No | Allow comments (default: true) |
| `hide_like_count` | boolean | No | Hide like count (default: false) |
| `hide_share_count` | boolean | No | Hide share count (default: false) |
| `post_to_story` | boolean | No | Also post to story (default: false) |
| `boost` | boolean | No | Boosted/promoted post (default: false) |
| `tagged_people` | jsonb | No | Tagged users array |
| `product_details` | jsonb | No | Product/shopping details |

**Minimal create:**
```json
{
  "user_id": "YOUR_USER_UUID",
  "content": "Hello!"
}
```

---

### comments

**Table:** `comments` -- Post comments.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `post_id` | uuid | Yes | ID of the post being commented on |
| `user_id` | uuid | Yes | Comment author's user ID |
| `content` | text | Yes | Comment text |
| `parent_comment_id` | uuid | No | Parent comment ID for nested replies |

**Create:**
```json
{
  "post_id": "POST_UUID",
  "user_id": "YOUR_USER_UUID",
  "content": "Great post!"
}
```

**Reply to a comment:**
```json
{
  "post_id": "POST_UUID",
  "user_id": "YOUR_USER_UUID",
  "content": "I agree!",
  "parent_comment_id": "PARENT_COMMENT_UUID"
}
```

---

### stories

**Table:** `stories` -- Ephemeral stories (24h).

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `user_id` | uuid | Yes | Story author's user ID |
| `media_url` | text | Yes | URL to story media |
| `media_type` | text | Yes | `image` or `video` |
| `privacy` | text | Yes | `public`, `friends`, `private` |
| `views` | integer | Yes | View count (default: 0) |
| `viewed_by` | array | Yes | Array of user IDs who viewed |
| `caption` | text | No | Story caption/text overlay |
| `is_highlight` | boolean | No | Saved to highlights (default: false) |
| `music_url` | text | No | Background music URL |
| `music_title` | text | No | Music title |
| `music_start_at` | integer | No | Music start offset |
| `music_duration` | integer | No | Music play duration |
| `duration` | integer | No | Story duration in seconds (default: 5) |

**Create:**
```json
{
  "user_id": "YOUR_USER_UUID",
  "media_url": "https://example.com/story.mp4",
  "media_type": "video",
  "privacy": "public",
  "views": 0,
  "viewed_by": []
}
```

---

### notifications

**Table:** `notifications` -- User notifications.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `user_id` | uuid | Yes | Notification recipient |
| `actor_id` | uuid | Yes | User who triggered the notification |
| `type` | text | Yes | `like`, `comment`, `follow`, `mention`, `share`, etc. |
| `message` | text | Yes | Notification message text |
| `is_read` | boolean | Yes | Read status (default: false) |
| `post_id` | uuid | No | Related post ID |
| `comment_id` | uuid | No | Related comment ID |

**Create:**
```json
{
  "user_id": "TARGET_UUID",
  "actor_id": "ACTOR_UUID",
  "type": "like",
  "message": "liked your post",
  "is_read": false
}
```

---

### pages

**Table:** `pages` -- Business/brand pages.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | text | Yes | Page name |
| `admin_id` | uuid | Yes | Page admin user ID |
| `description` | text | No | Page description |
| `category` | text | No | Page category |
| `cover_image` | text | No | Cover image URL |
| `profile_pic` | text | No | Profile picture URL |
| `button_type` | text | No | CTA button type |
| `button_url` | text | No | CTA button URL |
| `links` | jsonb | Yes | External links (default: `{}`) |
| `legal_info` | jsonb | Yes | Legal info (default: `{}`) |
| `work_education` | jsonb | Yes | Work/education info (default: `{}`) |
| `family_members` | jsonb | Yes | Family members (default: `{}`) |
| `archived` | boolean | Yes | Archive status (default: false) |

**Create:**
```json
{
  "name": "My Brand Page",
  "admin_id": "YOUR_USER_UUID",
  "links": {},
  "legal_info": {},
  "work_education": {},
  "family_members": {},
  "archived": false
}
```

---

### conversations

**Table:** `conversations` -- Chat conversations.

> **Note (chat RPCs):** The monolith-era chat RPCs (`get_or_create_dm`, `get_conversations_with_info`, `mark_messages_read`, `get_message_read_status`, `get_my_read_message_ids`, `mark_message_delivered`, `create_message_with_audio`, `can_see_content`) join tables spread across multiple physical projects and can never run in any single one — they fail with e.g. `relation "blocks" does not exist` (42P01). **RESOLVED (Aug 4, 2026, frontend `c57b6f2`):** `get_or_create_dm`, `get_conversations_with_info`, `mark_messages_read`, `get_message_read_status`, `get_my_read_message_ids`, and `mark_message_delivered` were replaced with per-domain gateway table queries in `tone-your-social-voice/src/api/conversations.ts` (+161 lines: `getOrCreateDM`, `markConversationMessagesRead`, `getConversationReadStatus`, `getMyReadMessageIds`, `markMessageDelivered`) and consumed by `useConversations.ts` / `useMessagingSystem.ts`. The frontend flow is fully table-based; do not route these RPCs anywhere.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `type` | text | Yes | `direct`, `group`, `page` |
| `created_by` | uuid | Yes | Creator user ID |
| `chat_theme` | text | Yes | Chat theme (default: `default`) |
| `can_add_members` | text | Yes | `true` or `false` |
| `name` | text | No | Group conversation name |
| `description` | text | No | Group description |
| `page_id` | uuid | No | Associated page ID |
| `quick_emoji` | text | No | Quick reaction emoji |

**Create:**
```json
{
  "type": "direct",
  "created_by": "YOUR_USER_UUID",
  "chat_theme": "default",
  "can_add_members": "true"
}
```

---

### hashtags

**Table:** `hashtags` -- Hashtag registry.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `tag` | text | Yes | Hashtag text (without #) |
| `follower_count` | integer | No | Number of followers (default: 0) |

**Create:**
```json
{
  "tag": "trending",
  "follower_count": 0
}
```

---

### advertisers

**Table:** `advertisers` -- Advertiser accounts.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | text | Yes | Advertiser name |
| `domain` | text | No | Company domain |
| `logo_url` | text | No | Logo URL |

**Create:**
```json
{
  "name": "Acme Corp",
  "domain": "acme.com",
  "logo_url": "https://example.com/logo.png"
}
```

---

## Realtime Endpoints (SSE)

Added **Aug 14, 2026** (`29f9559`; channel authorization tightened in `67ce1bd`) to back voice/video call signaling and any future realtime channels. All three routes require a Bearer token (`auth.authenticate`). Backing store is `src/realtime/channelHub.ts` — an in-memory SSE fan-out hub (subscribe/unsubscribe/publish with `excludeConnId`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/realtime/subscribe/:channel` | SSE stream for a channel. Sends an `init` event with `{connId}`, then `message` events carrying `{event, payload}`; 25s keep-alive heartbeat; connection removed from the hub on close. |
| `POST` | `/api/realtime/publish` | Broadcast to a channel. Body `{channel, event, payload, excludeConnId?}`. Returns `200 {ok, delivered}`. |
| `GET` | `/api/realtime/ice-servers` | WebRTC ICE configuration: Google STUN servers plus a TURN relay from `TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL` (defaults to the Metered OpenRelay public relay). Returns `{iceServers}`. |

Like all gateway state, the hub is process-local — signaling only fans out to connections on the same gateway instance, and **in-flight signals are lost if a subscriber's connection drops** (no replay buffer; the client reconnects with backoff but nothing is retransmitted).

**Authorization:** `subscribe` only accepts a channel owned by the caller — you may only subscribe to `calls:<yourUserId>` (any other channel returns `403`), so no client can read or spoof another user's signaling. `publish` accepts any valid `calls:<userId>` channel (that's how a call is initiated) and returns `{ok, delivered}` so the caller can detect a callee with no active connection. (Added in `67ce1bd`.)

> **Production caveat (Vercel):** the hub is single-process, so two users landing on different Vercel function instances never see each other's signaling, and Hobby-plan functions cap at a 300s duration — the SSE stream is killed mid-call for any call longer than 5 minutes (504 `FUNCTION_INVOCATION_TIMEOUT`). **This gateway's SSE signaling is therefore intended for local development** (`npm run dev`, single long-lived process) and best-effort in production. Production-grade signaling would need a shared pub/sub (e.g. Redis) or a dedicated long-lived relay host; WebRTC media itself remains peer-to-peer and is unaffected by these limits once the call is established.
>
> **Client-side mitigation (Aug 21, 2026, frontend `b5c54ff`):** because the 300s cap guarantees a reconnect window on every call longer than ~5 minutes, the frontend no longer trusts single-shot delivery for call teardown: `call-ended` publishes retry twice when the gateway reports `delivered=0`, incoming calls are accepted instead of auto-replied busy when the callee's own peer connection is `failed`/`closed`/missing, a watchdog ends zombie `'connected'` calls, unanswered rings time out after 45s, and the cross-tab active-call counter heartbeats (15s) with stale entries (>75s) self-clearing — so a lost signal or crashed tab can no longer leave a user permanently "busy".
>
> **Call chat-log messages (Aug 21, 2026, frontend `2042cfb`):** every terminal call path (ended / missed / declined / disconnected) now also writes one system message into the shared DM via the regular `messages` table — plaintext JSON envelope (`{"__call":{status,callType,duration}}`) in `content` with `is_system: true`, written by the caller only (same single-writer rule as `call_history`; no schema change, no new gateway route). Rendering/parsing lives in frontend `src/lib/callLog.ts`; busy dials are intentionally not logged. Live-update caveat fixed in `e195da5`: this gateway's client lib registers `postgres_changes` listeners but nothing ever delivers them (no server push), so open chats relied on reload; the frontend now bridges inserts via a `tone:call-log` window event instead.

```bash
# Subscribe (Bearer token required, keep the connection open)
curl -N -H "Authorization: Bearer TOKEN" \
  https://gateway-iota-two.vercel.app/api/realtime/subscribe/calls:USER_ID

# Publish a signal to a channel
curl -X POST https://gateway-iota-two.vercel.app/api/realtime/publish \
  -H "Content-Type: application/json" -H "Authorization: Bearer TOKEN" \
  -d '{"channel":"calls:USER_ID","event":"call-signal","payload":{"type":"offer","from":"UUID","to":"UUID","callType":"video"}}'

# Fetch ICE/TURN server config
curl -H "Authorization: Bearer TOKEN" \
  https://gateway-iota-two.vercel.app/api/realtime/ice-servers
```

---

## System Endpoints

Health and monitoring endpoints.

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| `GET` | `/api/system/health` | Gateway health check | No |
| `GET` | `/api/system/metrics` | Request metrics snapshot | Admin |
| `GET` | `/api/system/audit` | Audit log entries | Admin |
| `GET` | `/api/system/config` | Current gateway configuration | Admin |
| `GET` | `/api/system/features` | Enabled domain features | Admin |
| `GET` | `/api/system/storage` | All registered storage accounts | Admin |
| `GET` | `/api/system/services` | Discovered services | Admin |
| `GET` | `/api/system/queue` | Pending job queue count | Admin |
| `GET` | `/api/system/rate-limits` | Per-domain rate limit counters | Admin |
| `POST` | `/api/system/reload-registry` | Refresh project registry cache | Admin |

**Note (Aug 2026):** `/api/system/databases` was **removed** from the gateway source (`src/api/routes.ts:242`) — it previously exposed all service keys. Admin-gated endpoints return `503 "Admin access not configured"` while `ADMIN_API_KEY` is undefined.

### Security Warnings

> **RESOLVED:** `/api/system/databases` previously returned all Supabase project URLs and `service_role` keys (which bypass all RLS) with no authentication. It has been **removed** from the gateway source (`src/api/routes.ts:242`).

> **WARNING:** `/api/system/health` exposes server `uptime` (start time) and the `X-Gateway: Tone-API-Gateway` header. Combined, these provide fingerprinting data for attackers.

> **WARNING:** Admin routes (e.g. `/api/system/reload-registry`) use `authenticateAdmin`, but `ADMIN_API_KEY` is never defined — they always return 503. Additionally, there is no dedicated rate limiting on admin endpoints beyond the general rate limit.

### Example -- Health Check

```bash
curl https://gateway-iota-two.vercel.app/api/system/health
# {"status":"healthy","timestamp":"...","uptime":123.45}
```

### Example -- Check Domain Status

```bash
curl https://gateway-iota-two.vercel.app/api/system/features
# {"posts":true,"comments":true,"stories":true,...}
```

### Example -- Database Registry (REMOVED)

```bash
# /api/system/databases was removed from the gateway source (Aug 2026) —
# it previously exposed all service keys with no auth. It now 404s.
curl https://gateway-iota-two.vercel.app/api/system/databases
```

---

## Known Limitations

### Security (Must Fix Before Production)

1. **Authentication is partial** — Data routes (`/api/:domain`, `/api/:domain/:id`) require a Bearer token and return `401` without one. System endpoints except `/health` are admin-gated (`authenticateAdmin`), but `ADMIN_API_KEY` is undefined so they return 503 rather than data. `/api/system/databases` has been removed.
2. ~~**Service keys exposed**~~ — ~~`GET /api/system/databases` returns all Supabase `service_role` keys with no auth. These bypass all RLS policies.~~ **RESOLVED** — endpoint removed from source (`src/api/routes.ts:242`).
3. ~~**Hardcoded credentials in code**~~ — `src/infrastructure/database/infrastructureDb.ts:483-485` now retrieves keys from `process.env` instead of embedding them in source code.
4. **CORS wide open** — `src/api/middleware.ts:14` reflects any origin when `CORS_ORIGINS` is unset.
5. **Sign-up auto-confirms email** — unlimited account creation spam possible.
6. **Auth verification not domain-scoped** — `src/auth/index.ts:158-194` — `getAuthCredentials()` filters by domain and caches per-domain (line 50), but `verifyViaSupabase`/`getSupabaseClient`/`getAnonClient` call it with no argument and default to `'users'`, so JWT fallback always uses the `users` project's credentials.
7. **`constantTimeCompare` leaks length** — `src/auth/index.ts:78-83` returns early on length mismatch, defeating timing-safe comparison.
8. **`ADMIN_API_KEY` never defined** — admin auth system (`src/auth/index.ts:205`) always returns 503.
9. **JWT fallback bypass** — `src/auth/index.ts:151` falls back to Supabase `getUser()` on signature mismatch.

### Functional

10. **`profiles` domain auth-gated & unverified** — data route returns `401` without a Bearer token; the gateway resolves the `profiles` domain and the host answers HTTP 401. Reachability with a valid token is unconfirmed. `groups` is now online and queryable.
11. **Domain-to-table name mismatch** — `blocking` is the registered domain but the frontend queries `blocks`, and no `blocks` domain is registered (the `blocks` table lives in the `blocking` project — the blocking RPCs reference it); `music` / `music_library` are both registered now (queries succeed).
12. ~~**Sub-tables not accessible**~~ — **RESOLVED July 2026** — related tables (`likes`, `shares`, `saved_posts`, `story_views`, `message_requests`, `friends`, `other_names`, etc.) are now registered as their own gateway domains and routable via `/api/{table}`.
13. **PUT/DELETE require `/v1/` prefix** — Not available at base `/api/` path.
14. **Soft delete limited** — Only works if target table has `deletedAt` column (most don't).

### Reliability

15. **In-memory state** — Rate limits, audit logs, metrics, feature flags, permissions, search index, locks, and job queues all reset on Vercel cold starts.
16. **Circuit breaker doesn't trip** — `src/routing/router.ts:48-62` resets failure tracking on project swap during retry.
17. **Notification infinite retry** — `src/notifications/index.ts:36-39` re-enqueues failed notifications with no backoff or limit.
18. **Health check uses random values** — `src/infrastructure/monitoring/index.ts:28` returns `Math.random() * 200` instead of actual ping.
19. **`generateId` not collision-resistant** — `src/utils/index.ts:1-5` uses `Math.random()`, not `crypto.randomUUID()`.
20. **Provider fallback picks wrong provider** — `src/registry/databaseRegistry.ts:84-85` falls back to first provider of matching type.

### Code Quality

21. **Zero tests** — No test framework installed, no `*.test.*` or `*.spec.*` files.
22. **No CI/CD** — No pipeline config, no GitHub Actions, no deployment automation.
23. **No linting** — No `.eslintrc`, no prettier, no lint-staged, no husky.
24. **No `.env.example`** — Required env vars undocumented.
25. **No README** — No setup, architecture, or API reference documentation.
26. **No structured logging** — All error handling is `console.error`/`console.log`, ephemeral on Vercel.
27. **Massive code duplication** — `api/[...slug].ts` duplicates `src/dev.ts`; v1 routes duplicate top-level routes.
28. **All providers are stubs** — Storage (S3, R2, Cloudinary), Postgres, MongoDB providers all return fake data.
29. **3 unused dependencies** — `zod`, `pg`, `jose` installed but unused (JWT done manually with `crypto`).

---

## Direct Database Access (Deprecated)

> **GATEWAY-ONLY POLICY.** All access is routed through the gateway. The frontend and all clients talk exclusively to the gateway API and never hold database credentials or direct links; any operation not yet supported by the gateway (e.g., tables not registered as domains) should be added to the gateway rather than accessed directly.

> **SECURITY WARNING:** Service keys bypass all RLS policies. Never expose these keys in client-side code, never commit them to git, and never call a public endpoint for them. `/api/system/databases` (which previously returned these keys) has been removed from the gateway; all infrastructure credentials are managed via the gateway's environment configuration only.

### Better Approach: Add Gateway Support

To keep everything gateway-only, extend the gateway to support these operations (clients still call the gateway, never the origin):

1. **Add table name aliasing** — map `blocking` → `blocks`, `music` → `music_library` (partially done July 2026: `music_library` has its own domain; `blocks` still lacks a domain — only `blocking` is registered)
2. **Add sub-table routing** — e.g., `/api/posts/likes`, `/api/posts/shares` (mostly moot since July 2026 — sub-tables have their own domains)
3. **Add query filtering** — server-side `.eq()`, `.order()`, `.limit()` instead of client-side filtering
4. **Extend RPC proxying** — `POST /api/rpc/:function` exists (`src/api/routes.ts:283`, mounted at `routes.ts:390`) but is auth-gated and defaults to the `users` project (only `seed_default_ad_topics` is overridden); add per-function domain routing and verify with a working token
5. **Add storage proxying** — file upload passthrough via the gateway
6. **Add auth middleware** — JWT validation before any data access

---

## cURL Cheat Sheet

```bash
# Create a post
curl -X POST https://gateway-iota-two.vercel.app/api/posts \
  -H "Content-Type: application/json" \
  -d '{"user_id":"UUID","content":"Hello!"}'

# Read a post
curl https://gateway-iota-two.vercel.app/api/posts/POST_ID

# Update a post
curl -X PUT https://gateway-iota-two.vercel.app/api/v1/posts/POST_ID \
  -H "Content-Type: application/json" \
  -d '{"content":"Updated"}'

# Delete a post (permanent)
curl -X DELETE "https://gateway-iota-two.vercel.app/api/v1/posts/POST_ID?permanent=true"

# Create a comment
curl -X POST https://gateway-iota-two.vercel.app/api/comments \
  -H "Content-Type: application/json" \
  -d '{"post_id":"POST_UUID","user_id":"USER_UUID","content":"Nice!"}'

# Create a story
curl -X POST https://gateway-iota-two.vercel.app/api/stories \
  -H "Content-Type: application/json" \
  -d '{"user_id":"UUID","media_url":"https://...","media_type":"image","privacy":"public","views":0,"viewed_by":[]}'

# Create a notification
curl -X POST https://gateway-iota-two.vercel.app/api/notifications \
  -H "Content-Type: application/json" \
  -d '{"user_id":"UUID","actor_id":"UUID","type":"follow","message":"started following you","is_read":false}'

# Create a page
curl -X POST https://gateway-iota-two.vercel.app/api/pages \
  -H "Content-Type: application/json" \
  -d '{"name":"My Page","admin_id":"UUID","links":{},"legal_info":{},"work_education":{},"family_members":{},"archived":false}'

# Create a conversation
curl -X POST https://gateway-iota-two.vercel.app/api/conversations \
  -H "Content-Type: application/json" \
  -d '{"type":"direct","created_by":"UUID","chat_theme":"default","can_add_members":"true"}'

# Health check
curl https://gateway-iota-two.vercel.app/api/system/health
```

---

## Recommendations (Priority Order)

### P0 — Immediate (Security)

1. ~~**Rotate exposed credentials** — the Supabase `service_role` keys in `src/infrastructure/database/infrastructureDb.ts:483-485` and `.env` are compromised~~ **PARTIAL** — Deployment now reads keys from `process.env` (Vercel env vars), but the gitignored local `gateway/.env` still holds the key; rotation of the previously-committed key is unconfirmed, so treat it as compromised until rotated
2. ~~**Remove hardcoded keys from code** — delete the `service_key` fields from fallback data in `infrastructureDb.ts`~~ **DONE** — `process.env.INFRA_SUPABASE_URL` and `process.env.INFRA_SUPABASE_KEY`
3. ~~**Remove or protect `/api/system/databases`** — never expose service keys publicly~~ **DONE** — endpoint removed from source (`src/api/routes.ts:242`)
4. **Add gateway authentication** — JWT validation before any data access
5. **Fix CORS policy** — set explicit allowed origins in `src/api/middleware.ts:14`

### P1 — High Priority

6. **Verify/restore profiles host project** — the profiles host resolves and answers HTTP 401 (auth-gated), so it is reachable but unverified with a valid token; the profile page shows an empty state until confirmed. Groups host project is now online.
7. **Fix auth credential scoping** — `src/auth/index.ts:158-194` — pass the requested domain through `verifyViaSupabase`/`getSupabaseClient`/`getAnonClient` instead of defaulting to `'users'`
8. **Fix `constantTimeCompare`** — pad both buffers to equal length before comparison
9. **Define `ADMIN_API_KEY`** in `.env` — or remove the admin auth system if unused
10. **Implement server-side query filtering** — stop fetching entire tables to the client

### P2 — Medium Priority

11. **Fix circuit breaker integration** — don't reset failure tracking on project swap (`src/routing/router.ts:48-62`)
12. **Fix notification retry** — add backoff, retry limit, and dead-letter queue (`src/notifications/index.ts:36-39`)
13. **Fix health check** — use actual ping instead of `Math.random() * 200` (`src/infrastructure/monitoring/index.ts:28`)
14. **Use `crypto.randomUUID()`** — replace `Math.random()` in `generateId` (`src/utils/index.ts:1-5`)
15. **Add domain-to-table aliasing** — map `blocking` → `blocks` (partially done July 2026: `music_library` now has its own domain; `blocks` still lacks a domain — only `blocking` is registered)
16. **Extend RPC proxying** — `POST /api/rpc/:function` exists (`src/api/routes.ts:283`) but is auth-gated and defaults to the `users` project; add per-function domain routing and verify with a working token
17. **Add storage proxying** — file upload passthrough via the gateway

### P3 — Low Priority

18. **Add tests** — prioritize auth, routing, circuit breaker, and retry engine
19. **Add CI/CD** — linting, type checking, tests on every push
20. **Add linting** — ESLint + Prettier + lint-staged + husky
21. **Add `.env.example`** — document all required environment variables
22. **Add structured logging** — replace `console.error`/`console.log` with a proper logger
23. **Remove unused dependencies** — `zod`, `pg`, `jose`
24. **Eliminate code duplication** — merge `api/[...slug].ts` and `src/dev.ts`; remove duplicate route definitions
25. **Add README** — setup, architecture, and API reference documentation

---

## Summary

| Category | Count | Fixed |
|----------|-------|-------|
| Critical security issues | 4 | 2 |
| High-severity issues | 5 | 0 |
| Medium-severity issues | 3 | 0 |
| Low-severity issues | 15 | 6 |
| **Total issues** | **27** | **8** |

*Accounting (Aug 2026):* Critical = Security Audit #1–#4 (2 fixed: hardcoded keys, `/api/system/databases` removed). High = Audit #5–#9. Medium = Audit #10–#12. Low = Bugs #1–#15 (6 fixed: gateway/signaling-client #10–#15). Total = 27, fixed = 8, open = 19.

The gateway has a well-structured 29-module architecture with clean separation of concerns, a correct circuit breaker pattern, and a retry engine with exponential backoff. However, it is in **prototype state**: system endpoints are now admin-gated and `/api/system/databases` was removed, but `ADMIN_API_KEY` is undefined so admin endpoints always return 503; state is held in memory and resets on Vercel cold starts; and there is zero test coverage. The code works for demo purposes but is **not production-ready** without addressing the remaining security and reliability issues above. Gateway-**client** fixes: a July 2026 debugging session fixed join cardinality inversion and the dropped join-key column (Bugs #12, #13), and a July 2026 config-only session registered ~80 missing table-as-domain entries in the live infra DB (98/105 frontend-queried tables routable; 3 of the original 108 are storage buckets — activates on next cold start), resolving the "Failed to load friends"/"Failed to load other names" 404 toasts without any gateway source changes. An Aug 2, 2026 client session fixed the `not.` operator serialization and added `is`/count-join support plus a bulk-update fallback (Bug #14). Two Aug 4, 2026 changes follow up on those sessions: the gateway now re-enables feature flags for newly registered domains on the periodic `refreshRegistry` cycle (`e3ee66d`), removing the cold-start wait; and the frontend replaced the broken cross-project chat RPCs with per-domain gateway table queries in `src/api/conversations.ts` (`c57b6f2`, see the conversations schema note above).
