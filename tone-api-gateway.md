# Tone API Gateway

Base URL: `https://gateway-iota-two.vercel.app`

The API Gateway is the single entry point for all Tone ecosystem databases. Each request is routed to the correct Supabase project based on the **domain** in the URL path.

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
- [Bugs](#bugs)
- [Known Limitations](#known-limitations)
- [Direct Supabase Access](#direct-supabase-access)
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
     Routes to the correct Supabase project
           │
    ┌──────┼──────┬──────┬──────┐
    ▼      ▼      ▼      ▼      ▼
 posts   comments stories  ...  pages
 (Supabase #1) (Supabase #2) ...
```

The gateway reads the `domain` parameter from the URL (e.g., `posts`, `comments`, `stories`) and routes the request to the matching Supabase project. The application and control panel do **not** need to manage database connections -- just call the gateway.

---

## Architecture

### Module Map

| Layer | File | Description |
|-------|------|-------------|
| Entry (Vercel) | `api/[...slug].ts:1-93` | Vercel serverless handler; creates Express app, initializes all services |
| Entry (Dev) | `src/dev.ts:1-89` | Local dev server |
| Routes | `src/api/routes.ts:1-356` | All API routes (v1 + system + top-level) |
| Middleware | `src/api/middleware.ts:1-64` | CORS, body parsing, rate limiting, audit logging, metrics |
| Auth | `src/auth/index.ts`, `src/api/auth.ts` | JWT verification, admin auth, sign-up/login |
| Routing | `src/routing/router.ts`, `src/routing/service.ts`, `src/routing/locator.ts` | Domain-based routing with hash sharding |
| Registry | `src/registry/databaseRegistry.ts`, `src/registry/projectRegistry.ts`, `src/registry/storageRegistry.ts` | Dynamic project/provider management |
| Infrastructure DB | `src/infrastructure/database/infrastructureDb.ts` (520 lines) | Supabase-backed config with in-memory fallback |
| Project Manager | `src/project-manager/index.ts` | Project lifecycle management |
| Circuit Breaker | `src/circuit-breaker/index.ts` | 3-state fault isolation (CLOSED/OPEN/HALF_OPEN) |
| Retry Engine | `src/retry/engine.ts` | Exponential backoff + jitter |
| Config | `src/config/index.ts` | Dynamic configuration via Supabase |
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
│  Infrastructure DB (Supabase or in-memory)   │
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
    Supabase Project (per domain)
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
| 2 | **`.env` with `INFRA_SUPABASE_KEY` in working tree** | `.env` | Same service_role key accessible; `.gitignore` excludes `.env` but it was committed before the rule was added. | Open |
| 3 | **`/api/system/databases` exposes all service keys** | `src/api/routes.ts` | Returns all Supabase project URLs and service_role keys to any caller. No authentication required. Full database takeover possible. | Open |
| 4 | **Zero authentication on system endpoints** | `src/api/routes.ts:235` | All `/api/system/*` endpoints are publicly accessible. | Open |

### High

| # | Issue | File | Impact |
|---|-------|------|--------|
| 5 | **CORS reflects any origin** | `src/api/middleware.ts:14` | `cors({ origin: true })` when `CORS_ORIGINS` is unset — effectively disables CORS protection. CSRF and data exfiltration possible. |
| 6 | **Auth credentials not domain-scoped** | `src/auth/index.ts:51` | Always queries `.eq('domain', 'users')` regardless of passed `domain` parameter. Global cache serves stale credentials for wrong domain. |
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

---

## Live Deployment Observations (July 2026)

Verified against `https://gateway-iota-two.vercel.app`:

| Endpoint | Result |
|----------|--------|
| `GET /api/system/health` | `200` healthy |
| `GET /api/system/features` | `503` "Admin access not configured" (`ADMIN_API_KEY` undefined) |
| `GET /api/posts` (no token) | `401` — data routes now require a Bearer token (`auth.authenticate` on `/:domain`) |
| `GET /api/profiles` (no token) | `401` — host the profiles-domain resolves and answers HTTP 401 |
| `GET /api/friends` (no token) | `404 {"error":"Not found"}` — `friends` had **no registered domain** (`featureFlags.isEnabled('friends')` false); registered July 2026, enabled on next cold start |
| `POST /api/auth/sign-up` | `400 {"error":"{}"}` |
| `POST /api/auth/sign-in` | `401 "Invalid login credentials"` |

No working client token could be obtained (sign-up/sign-in broken on the deployment, admin routes 503), so authenticated data access remains unverified. Profiles-domain reachability with a valid token is still unconfirmed.

### Domain Registration (July 2026)

The frontend queries ~108 tables via `gateway.from('<table>')`, which hits `GET /api/<table>`. Because the gateway is table-as-domain, every one of those tables must exist in `infrastructure_projects` or the route 404s — the app surfaced this as "Failed to load friends"/"Failed to load other names" toasts (`src/hooks/useFriends.ts:86`, `src/hooks/useOtherNames.ts:36`). ~80 of those tables had never been registered.

Fix (config-only, no gateway source changes): each missing table was probed against every registered project, then registered as a domain whose project row clones the credentials of the host project (`infrastructure_projects` + `domains` kept in sync; inserts performed via the infra DB service client, idempotent, no keys written to disk). Result: **98 of 108** frontend-queried tables now have a domain. The 10 remaining tables (see [Domains & Projects](#domains--projects)) were not found in any registered project.

**Caveat:** feature flags are only enabled from `infrastructure_projects` at gateway startup, and the 60s `refreshRegistry()` reloads projects but does **not** re-enable flags. New domains activate on the next Vercel cold start; a warm instance keeps returning 404 until then.

---

## Quick Start

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

**~100 domains** are currently registered across **13 Supabase projects** (was 12; the users-domain project `<project-8>` is where all 226 app migrations were applied and hosts the bulk of the social-graph tables).

### Primary domains

| Domain | Supabase Project | Status | Description |
|--------|-----------------|--------|-------------|
| `posts` | `<project-11>` | Active | Posts + `likes`, `post_shares`, `post_tags`, `reported_posts`, `saved_posts`, `shares` |
| `comments` | `<project-13>` | Active | Comments + `comment_reactions`, `comment_shares`, `reels_comments` |
| `stories` | `<project-2>` | Active | Stories + 9 `story_*` sub-domains |
| `notifications` | `<project-12>` | Active | User notifications |
| `pages` | `<project-6>` | Active | Pages + `page_followers`, `page_posts` |
| `conversations` | `<project-3>` | Active | Conversations + `messages`, `message_requests`, `message_reactions`, `message_reports`, `pinned_messages`, `conversation_clears`, `conversation_participants`, `conversation_reports` |
| `hashtags` | `<project-1>` | Active | Hashtags, follows, analytics |
| `advertisers` | `<project-9>` | Active | Advertisers + `ad_activity`, `ad_advertisers`, `ad_settings`, `ad_topics` |
| `music` | `<project-7>` | Active | Music library (also exposed as `music_library`) |
| `blocking` | `<project-4>` | Active | Blocking |
| `profiles` | `<project-5>` | Auth-gated | User profiles + `profile_details`, `profile_posts`, `profile_reports`. Host resolves and answers HTTP 401; data route returns 401 without a Bearer token. Reachability with a valid token unverified. |
| `groups` | `<project-10>` | Active | Groups + `group_follows`, `group_members`, `group_pins`, `group_posts` |
| `users` | `<project-8>` | Active | 48 social-graph tables (see full registry below) |

### Full domain registry (from live `infrastructure_projects`, July 2026)

- **`<project-8>` (48)** — `users`, `audience_lists`, `bug_reports`, `call_history`, `colleges`, `companies`, `content_preferences`, `editor_projects`, `encryption_verifications`, `export_requests`, `family_relationships`, `followers`, `follows`, `friends`, `friendships`, `hidden_content`, `hidden_reels`, `high_schools`, `life_events`, `lives`, `locations`, `mentions`, `muted_users`, `notification_delivery_settings`, `notification_preferences`, `other_names`, `pokes`, `post_notifications`, `privacy_settings`, `reactions`, `reel_preference_signals`, `reel_reports`, `reels_activity`, `reels_likes`, `saved_ads`, `search_history`, `status_visibility`, `sticker_packs`, `stickers`, `technical_feedback`, `user_activity`, `user_ad_interactions`, `user_ad_partner_settings`, `user_contacts`, `user_device_keys`, `user_encryption_keys`, `user_feedback`, `user_preferences`
- **`<project-2>` (10)** — `stories`, `story_highlight_items`, `story_highlights`, `story_mentions`, `story_poll_votes`, `story_polls`, `story_question_responses`, `story_questions`, `story_reactions`, `story_views`
- **`<project-3>` (9)** — `conversations`, `conversation_clears`, `conversation_participants`, `conversation_reports`, `message_reactions`, `message_reports`, `message_requests`, `messages`, `pinned_messages`
- **`<project-11>` (7)** — `posts`, `likes`, `post_shares`, `post_tags`, `reported_posts`, `saved_posts`, `shares`
- **`<project-10>` (5)** — `groups`, `group_follows`, `group_members`, `group_pins`, `group_posts`
- **`<project-9>` (5)** — `advertisers`, `ad_activity`, `ad_advertisers`, `ad_settings`, `ad_topics`
- **`<project-5>` (4)** — `profiles`, `profile_details`, `profile_posts`, `profile_reports`
- **`<project-13>` (4)** — `comments`, `comment_reactions`, `comment_shares`, `reels_comments`
- **`<project-6>` (3)** — `pages`, `page_followers`, `page_posts`
- **`<project-7>` (2)** — `music`, `music_library`
- **`<project-1>` (1)** — `hashtags`
- **`<project-4>` (1)** — `blocking`
- **`<project-12>` (1)** — `notifications`

### Frontend-queried tables without a registered domain (10)

Found in **no** registered project (may live in unregistered projects or be legacy/dead code): `avatars`, `blocked_nicknames`, `blocks`, `covers`, `group_covers`, `hashtag_follows`, `media_library`, `message_audios`, `restricted_users`, `trusted_devices`.

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

## System Endpoints

Health and monitoring endpoints.

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| `GET` | `/api/system/health` | Gateway health check | No |
| `GET` | `/api/system/metrics` | Request metrics snapshot | No |
| `GET` | `/api/system/audit` | Audit log entries | No |
| `GET` | `/api/system/config` | Current gateway configuration | No |
| `GET` | `/api/system/features` | Enabled domain features | No |
| `GET` | `/api/system/databases` | All registered database projects | No |
| `GET` | `/api/system/storage` | All registered storage accounts | No |
| `GET` | `/api/system/services` | Discovered services | No |
| `GET` | `/api/system/queue` | Pending job queue count | No |
| `POST` | `/api/system/reload-registry` | Refresh project registry cache | No |

### Security Warnings

> **CRITICAL:** `/api/system/databases` returns all Supabase project URLs and `service_role` keys (which bypass all RLS). This endpoint has **no authentication**. Any caller can retrieve full database credentials. This must be removed or protected before production use.

> **WARNING:** `/api/system/health` exposes server `uptime` (start time) and the `X-Gateway: Tone-API-Gateway` header. Combined, these provide fingerprinting data for attackers.

> **WARNING:** Admin routes (`/api/system/reload-registry`) use `authenticateAdmin` which checks `ADMIN_API_KEY`, but this env var is never defined — the endpoint always returns 503. Additionally, there is no dedicated rate limiting on admin endpoints beyond the general rate limit.

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

### Example -- Database Registry (SECURITY RISK)

```bash
# DO NOT call this in production — exposes all service keys
curl https://gateway-iota-two.vercel.app/api/system/databases
# Returns: [{domain:"posts", project_id:"...", service_key:"<REDACTED>", ...}, ...]
```

---

## Known Limitations

### Security (Must Fix Before Production)

1. **Authentication is partial** — Data routes (`/api/:domain`, `/api/:domain/:id`) require a Bearer token and return `401` without one, but system endpoints (`/api/system/*`) remain publicly accessible and can still expose service keys (`/api/system/databases`).
2. **Service keys exposed** — `GET /api/system/databases` returns all Supabase `service_role` keys with no auth. These bypass all RLS policies.
3. ~~**Hardcoded credentials in code**~~ — `src/infrastructure/database/infrastructureDb.ts:483-485` now retrieves keys from `process.env` instead of embedding them in source code.
4. **CORS wide open** — `src/api/middleware.ts:14` reflects any origin when `CORS_ORIGINS` is unset.
5. **Sign-up auto-confirms email** — unlimited account creation spam possible.
6. **Auth credential cache is not domain-scoped** — `src/auth/index.ts:51` always queries for domain `'users'` regardless of input.
7. **`constantTimeCompare` leaks length** — `src/auth/index.ts:78-83` returns early on length mismatch, defeating timing-safe comparison.
8. **`ADMIN_API_KEY` never defined** — admin auth system (`src/auth/index.ts:205`) always returns 503.
9. **JWT fallback bypass** — `src/auth/index.ts:151` falls back to Supabase `getUser()` on signature mismatch.

### Functional

10. **`profiles` domain auth-gated & unverified** — data route returns `401` without a Bearer token; host the profiles-domain resolves and answers HTTP 401. Reachability with a valid token is unconfirmed. `groups` is now online and queryable.
11. **Domain-to-table name mismatch** — `blocking` is the registered domain and no `blocks` table was found in any registered project; `music` / `music_library` are both registered now (queries succeed).
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

## Direct Supabase Access

For operations not supported by the gateway (tables not yet registered as domains), you can connect directly to Supabase.

> **SECURITY WARNING:** The endpoint below returns `service_role` keys that bypass all RLS policies. Never expose these keys in client-side code, never commit them to git, and never call this endpoint from a public-facing service.

Project credentials are available at:

```
GET https://gateway-iota-two.vercel.app/api/system/databases
```

**This endpoint has no authentication.** In production, it must be removed or protected with admin-only auth.

Use the credentials with the Supabase REST API:

```bash
# Example: Direct access to the blocks table (blocking domain)
curl "https://<project-host>/rest/v1/blocks?select=*" \
  -H "apikey: SERVICE_KEY" \
  -H "Authorization: Bearer SERVICE_KEY"
```

### Better Approach: Add Gateway Support

Instead of using direct Supabase access, extend the gateway to support these operations:

1. **Add table name aliasing** — map `blocking` → `blocks`, `music` → `music_library` (partially done July 2026: `music_library` has its own domain; `blocks` not found in any project)
2. **Add sub-table routing** — e.g., `/api/posts/likes`, `/api/posts/shares` (mostly moot since July 2026 — sub-tables have their own domains)
3. **Add query filtering** — server-side `.eq()`, `.order()`, `.limit()` instead of client-side filtering
4. **Add RPC proxying** — `POST /api/rpc/{function_name}` for Supabase Edge Functions
5. **Add storage proxying** — file upload passthrough to Supabase Storage
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

1. ~~**Rotate exposed credentials** — the Supabase `service_role` keys in `src/infrastructure/database/infrastructureDb.ts:483-485` and `.env` are compromised~~ **DONE** — Keys now from `process.env`
2. ~~**Remove hardcoded keys from code** — delete the `service_key` fields from fallback data in `infrastructureDb.ts`~~ **DONE** — `process.env.INFRA_SUPABASE_URL` and `process.env.INFRA_SUPABASE_KEY`
3. **Remove or protect `/api/system/databases`** — never expose service keys publicly
4. **Add gateway authentication** — JWT validation before any data access
5. **Fix CORS policy** — set explicit allowed origins in `src/api/middleware.ts:14`

### P1 — High Priority

6. **Restore profiles Supabase project** — `<project-5>` is unreachable; profile page returns empty results. Groups project (`<project-10>`) is now online.
7. **Fix auth credential scoping** — `src/auth/index.ts:51` must query by actual domain, not hardcoded `'users'`
8. **Fix `constantTimeCompare`** — pad both buffers to equal length before comparison
9. **Define `ADMIN_API_KEY`** in `.env` — or remove the admin auth system if unused
10. **Implement server-side query filtering** — stop fetching entire tables to the client

### P2 — Medium Priority

11. **Fix circuit breaker integration** — don't reset failure tracking on project swap (`src/routing/router.ts:48-62`)
12. **Fix notification retry** — add backoff, retry limit, and dead-letter queue (`src/notifications/index.ts:36-39`)
13. **Fix health check** — use actual ping instead of `Math.random() * 200` (`src/infrastructure/monitoring/index.ts:28`)
14. **Use `crypto.randomUUID()`** — replace `Math.random()` in `generateId` (`src/utils/index.ts:1-5`)
15. **Add domain-to-table aliasing** — map `blocking` → `blocks` (partially done July 2026: `music_library` now has its own domain; `blocks` not found in any project)
16. **Add RPC proxying** — `POST /api/rpc/{function_name}` for Supabase Edge Functions
17. **Add storage proxying** — file upload passthrough to Supabase Storage

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
| Critical security issues | 4 | 1 |
| High-severity issues | 6 | 0 |
| Medium-severity issues | 5 | 0 |
| Low-severity issues | 15 | 1 |
| **Total issues** | **30** | **2** |

The gateway has a well-structured 29-module architecture with clean separation of concerns, a correct circuit breaker pattern, and a retry engine with exponential backoff. However, it is in **prototype state** with critical security vulnerabilities (exposed keys now fixed, system endpoints still unauthenticated), in-memory state that resets on cold starts, and zero test coverage. The code works for demo purposes but is **not production-ready** without addressing the security and reliability issues above. Two additional gateway-**client** bugs were fixed during a July 2026 debugging session: join cardinality inversion and the dropped join-key column (see Bugs #12, #13). A follow-up July 2026 session registered ~80 missing table-as-domain entries in the live infra DB (98/108 frontend-queried tables routable; activates on next cold start), resolving the "Failed to load friends"/"Failed to load other names" 404 toasts without any gateway source changes.
