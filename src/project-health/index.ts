import { infrastructureDb } from '../infrastructure/database/infrastructureDb';
import type { InfrastructureProjectRow, KeepAliveStateRow } from '../db/schema';

/** Coarse per-project health vocabulary used by the status API. */
export type ProjectHealth = 'healthy' | 'unhealthy' | 'unknown' | 'excluded';

/**
 * Internal probe state. `active`/`unreachable` are kept as the in-memory
 * vocabulary; persisted `health_status` uses online/offline/unknown.
 */
export type KeepAliveState = 'active' | 'unreachable' | 'unknown' | 'excluded';
export type ProjectHealthState = KeepAliveState;

interface ProjectStatus {
  state: KeepAliveState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface TickSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Projects whose scheduled time had arrived (== probed this tick). */
  due: number;
  probed: number;
  online: number;
  unreachable: number;
}

export interface RunSummary extends TickSummary {
  /** @deprecated pre-scheduler field: every tick probes exactly its due slice. */
  total: number;
}

const PROBE_TIMEOUT_MS = 10000;
const MAX_CONCURRENCY = 5;
const DEFAULT_CHECKS_PER_DAY = 10;
const DEFAULT_TICK_INTERVAL_MS = 60000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Base delay before the very first slot so a fresh deployment never bursts. */
const SEED_BASE_DELAY_MS = 30000;

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min && raw <= max ? Math.floor(raw) : fallback;
}

/** How many light keep-alive requests each project receives per 24h (default 10). */
function checksPerDayFromEnv(): number {
  return intFromEnv('KEEP_ALIVE_CHECKS_PER_DAY', DEFAULT_CHECKS_PER_DAY, 1, 288);
}

/** Spacing between two probes of the SAME project: 24h / 10 = 2h 24m by default. */
function periodMs(): number {
  return DAY_MS / checksPerDayFromEnv();
}

function isEnabled(): boolean {
  return process.env.KEEP_ALIVE_ENABLED !== 'false';
}

function healthStatusFromState(state: KeepAliveState): 'online' | 'offline' | 'unknown' {
  switch (state) {
    case 'active': return 'online';
    case 'unreachable': return 'offline';
    default: return 'unknown';
  }
}

function healthFromState(state: KeepAliveState): ProjectHealth {
  switch (state) {
    case 'active': return 'healthy';
    case 'unreachable': return 'unhealthy';
    case 'excluded': return 'excluded';
    default: return 'unknown';
  }
}

/**
 * Distributed keep-alive scheduler ("10 light requests / 24h per project").
 *
 * Flow: infrastructure_projects → KeepAliveScheduler → every project
 *       → 10 checks / 24h (≈ one every 2h 24m, staggered across projects)
 *       → last_activity_at → health_status.
 *
 * Instead of probing the whole registry in one daily burst, each project owns a
 * persisted schedule (`keep_alive_state.next_keepalive_at`). Every tick claims
 * only the projects whose slot has arrived — claim-before-probe keeps multiple
 * serverless instances from double-probing — sends ONE genuine read-only request
 * (`GET /rest/v1/{domain}?select=*&limit=1`, no synthetic data), then advances the
 * schedule by exactly one period. Slots are seeded with a deterministic stagger
 * (`index * period / N`) so ticks stay light instead of synchronized.
 *
 * Drivers: Vercel Cron (`POST|GET /api/project-health/run`), an opportunistic
 * throttled tick on live traffic (`maybeTick()`), and the in-process interval in
 * long-lived processes (`start()`, dev only).
 */
class KeepAliveScheduler {
  private statuses = new Map<string, ProjectStatus>();
  /** Working copy of the schedule; rebuilt from the DB when the store exists. */
  private schedules = new Map<string, KeepAliveStateRow>();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;

  /**
   * Probe exactly the projects whose keep-alive slot is due.
   * Safe to call frequently: with nothing due this costs one small read.
   */
  async tick(): Promise<TickSummary | { skipped: 'already-running' | 'disabled' }> {
    if (!isEnabled()) return { skipped: 'disabled' };
    if (this.running) return { skipped: 'already-running' };
    this.running = true;

    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    try {
      const projects = await infrastructureDb.getProjects();
      const targets = projects.filter(p => p.status === 'active' && !!p.project_url);
      const byKey = new Map(targets.map(p => [p.project_key, p]));

      const persisted = await infrastructureDb.getKeepAliveStates();
      const storeAvailable = persisted !== null;
      if (storeAvailable) {
        this.schedules = new Map(persisted!.map(row => [row.project_key, row]));
      }

      const now = Date.now();
      const nowIso = new Date(now).toISOString();

      // Seed schedules for projects that have none yet. Deterministic stagger:
      // spread the N projects evenly across one period so ticks stay light
      // (project i probes at base + i * period / N, then every `period`).
      let seededAny = false;
      targets.forEach((project, index) => {
        if (this.schedules.has(project.project_key)) return;
        const offset = SEED_BASE_DELAY_MS + (index * periodMs()) / Math.max(targets.length, 1);
        this.schedules.set(project.project_key, {
          project_key: project.project_key,
          project_name: project.project_key,
          last_keepalive_at: null,
          next_keepalive_at: new Date(now + offset).toISOString(),
          keepalive_count_24h: 0,
          count_window_start: nowIso,
          health_status: 'unknown',
          consecutive_failures: 0,
          latency_ms: null,
          last_error: null,
          updated_at: nowIso,
        });
        seededAny = true;
      });
      if (seededAny && storeAvailable) {
        await this.persist([...byKey.keys()].map(key => this.schedules.get(key)!));
      }

      // Claim each due slot atomically before probing so concurrent instances
      // (cron racing live traffic) cannot double-probe the same project. The
      // next slot is anchored to `now` (not to the overdue stamp) so a lapsed
      // schedule resumes evenly instead of bursting through missed slots.
      const claimedKeys: string[] = [];
      for (const key of byKey.keys()) {
        const row = this.schedules.get(key)!;
        if (new Date(row.next_keepalive_at).getTime() > now) continue;

        const nextIso = new Date(now + periodMs()).toISOString();

        let claimed: boolean;
        if (storeAvailable) {
          claimed = await infrastructureDb.claimKeepAliveSlot(key, nowIso, nextIso);
        } else {
          claimed = true;
        }
        if (!claimed) continue;

        row.next_keepalive_at = nextIso;
        row.updated_at = nowIso;
        claimedKeys.push(key);
      }
      if (!storeAvailable && claimedKeys.length > 0) {
        await this.persist(claimedKeys.map(key => this.schedules.get(key)!));
      }

      let online = 0;
      let unreachable = 0;
      for (let i = 0; i < claimedKeys.length; i += MAX_CONCURRENCY) {
        const batch = claimedKeys.slice(i, i + MAX_CONCURRENCY);
        const results = await Promise.all(batch.map(key => this.probe(byKey.get(key)!)));
        for (const ok of results) ok ? online++ : unreachable++;
      }

      this.lastTickAt = Date.now();
      return {
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        due: claimedKeys.length,
        probed: claimedKeys.length,
        online,
        unreachable,
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Manual full round (admin/debug): probe EVERY active project immediately,
   * then re-stagger their future slots evenly from now.
   */
  async runAll(): Promise<RunSummary | { skipped: 'already-running' | 'disabled' }> {
    if (!isEnabled()) return { skipped: 'disabled' };
    if (this.running) return { skipped: 'already-running' };
    this.running = true;

    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    try {
      const projects = await infrastructureDb.getProjects();
      const targets = projects.filter(p => p.status === 'active' && !!p.project_url)
        .sort((a, b) => a.project_key.localeCompare(b.project_key));
      const now = Date.now();

      let online = 0;
      let unreachable = 0;
      for (let i = 0; i < targets.length; i += MAX_CONCURRENCY) {
        const results = await Promise.all(
          targets.slice(i, i + MAX_CONCURRENCY).map(p => this.probe(p)),
        );
        for (const ok of results) ok ? online++ : unreachable++;
      }

      // Re-stagger future slots evenly across one period so the registry does
      // not synchronize on this manual burst.
      targets.forEach((project, index) => {
        const status = this.ensureStatus(project);
        const offset = SEED_BASE_DELAY_MS + (index * periodMs()) / Math.max(targets.length, 1);
        const next = new Date(now + offset).toISOString();
        this.schedules.set(project.project_key, {
          project_key: project.project_key,
          project_name: project.project_key,
          last_keepalive_at: status.lastSuccessAt ?? status.lastAttemptAt,
          next_keepalive_at: next,
          keepalive_count_24h: 1,
          count_window_start: new Date(now).toISOString(),
          health_status: healthStatusFromState(status.state),
          consecutive_failures: status.consecutiveFailures,
          latency_ms: status.latencyMs,
          last_error: status.lastError,
          updated_at: new Date(now).toISOString(),
        });
      });
      await this.persist(targets.map(p => this.schedules.get(p.project_key)!));

      this.lastTickAt = Date.now();
      const total = targets.length;
      return {
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        due: total,
        probed: total,
        online,
        unreachable,
        total,
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Opportunistic driver for serverless: call fire-and-forget on live traffic.
   * Self-throttled (default ≥60s between attempts per instance) and fully
   * error-swallowing — it must never affect request handling.
   */
  maybeTick(): void {
    if (this.running || !isEnabled()) return;
    const minGapMs = intFromEnv('KEEP_ALIVE_TICK_MIN_GAP_MS', DEFAULT_TICK_INTERVAL_MS, 5000, DAY_MS);
    if (Date.now() - this.lastTickAt < minGapMs) return;
    if (!infrastructureDb.isInitialized()) return;
    this.lastTickAt = Date.now();
    this.tick().catch(err =>
      console.warn('[KeepAlive] Opportunistic tick failed:', (err as Error).message),
    );
  }

  private async persist(rows: KeepAliveStateRow[]): Promise<void> {
    for (const row of rows) {
      await infrastructureDb.upsertKeepAliveState({ ...row });
    }
  }

  private ensureStatus(project: InfrastructureProjectRow): ProjectStatus {
    let status = this.statuses.get(project.id);
    if (!status) {
      status = {
        state: 'unknown',
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        latencyMs: null,
        consecutiveFailures: 0,
        lastError: null,
      };
      this.statuses.set(project.id, status);
    }
    return status;
  }

  private async probe(project: InfrastructureProjectRow): Promise<boolean> {
    const status = this.ensureStatus(project);
    status.lastAttemptAt = new Date().toISOString();

    const base = project.project_url.replace(/\/+$/, '');
    const url = `${base}/rest/v1/${encodeURIComponent(project.domain)}?select=*&limit=1`;
    const start = Date.now();

    try {
      const res = await fetch(url, {
        headers: {
          apikey: project.service_key,
          Authorization: `Bearer ${project.service_key}`,
        },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - start;
      const contentType = res.headers.get('content-type') || '';

      let dbEngaged = res.ok && contentType.includes('application/json');
      if (!res.ok && contentType.includes('application/json')) {
        const body = await res.json().catch(() => null) as { code?: unknown } | null;
        dbEngaged = typeof body?.code === 'string';
      }

      if (dbEngaged) {
        await this.recordSuccess(project, latencyMs, `HTTP ${res.status}`);
        return true;
      }

      await this.recordFailure(project, `HTTP ${res.status} (${contentType.split(';')[0] || 'no content-type'})`);
      return false;
    } catch (err) {
      await this.recordFailure(project, (err as Error).message);
      return false;
    }
  }

  private bumpCount24h(row: KeepAliveStateRow, nowIso: string): void {
    const now = Date.now();
    const windowStart = new Date(row.count_window_start).getTime();
    if (!Number.isFinite(windowStart) || now - windowStart >= DAY_MS) {
      row.count_window_start = nowIso;
      row.keepalive_count_24h = 0;
    }
    row.keepalive_count_24h += 1;
  }

  private async saveSchedule(project: InfrastructureProjectRow, status: ProjectStatus): Promise<void> {
    const row = this.schedules.get(project.project_key);
    if (!row) return;
    row.last_keepalive_at = status.lastSuccessAt ?? status.lastAttemptAt;
    row.health_status = healthStatusFromState(status.state);
    row.consecutive_failures = status.consecutiveFailures;
    row.latency_ms = status.latencyMs;
    row.last_error = status.lastError;
    row.updated_at = new Date().toISOString();
    this.bumpCount24h(row, row.updated_at);

    try {
      await infrastructureDb.upsertKeepAliveState({ ...row });
    } catch (err) {
      console.warn(`[KeepAlive] Failed to persist schedule for ${project.project_key}:`, (err as Error).message);
    }
  }

  private async recordSuccess(project: InfrastructureProjectRow, latencyMs: number, detail: string): Promise<void> {
    const status = this.ensureStatus(project);
    status.state = 'active';
    status.latencyMs = latencyMs;
    status.consecutiveFailures = 0;
    status.lastError = null;
    status.lastSuccessAt = new Date().toISOString();

    try {
      await infrastructureDb.updateProjectHealth(project.id, latencyMs, project.used_space);
      await infrastructureDb.logHealth({
        resource_type: 'database',
        resource_id: project.project_key,
        status: 'online',
        latency_ms: latencyMs,
        usage_pct: 0,
        error_message: detail,
      });
    } catch (err) {
      console.error(`[KeepAlive] Failed to persist success for ${project.project_key}:`, (err as Error).message);
    }
    await this.saveSchedule(project, status);
  }

  private async recordFailure(project: InfrastructureProjectRow, message: string): Promise<void> {
    const status = this.ensureStatus(project);
    status.state = 'unreachable';
    status.consecutiveFailures += 1;
    status.lastError = message;
    status.lastFailureAt = new Date().toISOString();

    try {
      await infrastructureDb.logHealth({
        resource_type: 'database',
        resource_id: project.project_key,
        status: 'offline',
        latency_ms: 0,
        usage_pct: 0,
        error_message: message.slice(0, 500),
      });
      await infrastructureDb.updateProjectHealthStatus(project.id, 'offline');
    } catch (err) {
      console.error(`[KeepAlive] Failed to persist failure for ${project.project_key}:`, (err as Error).message);
    }
    await this.saveSchedule(project, status);
  }

  async getStatus(): Promise<{
    generatedAt: string;
    intervalHours: number;
    checksPerDay: number;
    periodMinutes: number;
    schedulerRunning: boolean;
    scheduleStoreAvailable: boolean;
    summary: { total: number; healthy: number; unhealthy: number; unknown: number };
    projects: Array<Record<string, unknown>>;
  }> {
    const projects = await infrastructureDb.getProjects();
    const persisted = await infrastructureDb.getKeepAliveStates();
    const persistedRows = new Map((persisted ?? []).map(r => [r.project_key, r]));
    const scheduleStoreAvailable = persisted !== null;

    const rows = projects.map(p => {
      const mem = this.statuses.get(p.id);
      const row = this.schedules.get(p.project_key) ?? persistedRows.get(p.project_key) ?? null;
      const state: KeepAliveState = p.status !== 'active'
        ? 'excluded'
        : mem?.state ?? (row?.health_status === 'online' ? 'active' : row?.health_status === 'offline' ? 'unreachable' : 'unknown');
      return {
        project_name: p.project_key,
        project_key: p.project_key,
        domain: p.domain,
        registry_status: p.status,
        state,
        health: healthFromState(state),
        health_status: row?.health_status ?? 'unknown',
        last_keepalive_at: row?.last_keepalive_at ?? null,
        next_keepalive_at: p.status === 'active' ? row?.next_keepalive_at ?? null : null,
        keepalive_count_24h: row?.keepalive_count_24h ?? 0,
        last_attempt_at: mem?.lastAttemptAt ?? null,
        last_success_at: mem?.lastSuccessAt ?? p.last_health_check,
        last_failure_at: mem?.lastFailureAt ?? null,
        latency_ms: mem?.latencyMs ?? row?.latency_ms ?? p.response_time,
        consecutive_failures: mem?.consecutiveFailures ?? row?.consecutive_failures ?? 0,
        last_error: mem?.lastError ?? row?.last_error ?? null,
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      intervalHours: 24 / checksPerDayFromEnv(),
      checksPerDay: checksPerDayFromEnv(),
      periodMinutes: Math.round(periodMs() / 60000),
      schedulerRunning: this.timer !== null,
      scheduleStoreAvailable,
      summary: {
        total: rows.length,
        healthy: rows.filter(r => r.health === 'healthy').length,
        unhealthy: rows.filter(r => r.health === 'unhealthy').length,
        unknown: rows.filter(r => r.health === 'unknown').length,
      },
      projects: rows,
    };
  }

  getHistory(projectKey: string, limit = 20) {
    return infrastructureDb.getHealthLogs('database', projectKey, limit);
  }

  /** In-process tick loop — only useful for long-lived processes (local dev). */
  start(): void {
    if (this.timer || !isEnabled()) return;
    const ms = intFromEnv('KEEP_ALIVE_TICK_INTERVAL_MS', DEFAULT_TICK_INTERVAL_MS, 5000, DAY_MS);
    this.timer = setInterval(() => {
      this.tick().catch(err =>
        console.error('[KeepAlive] Scheduled tick failed:', (err as Error).message),
      );
    }, ms);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const keepAliveScheduler = new KeepAliveScheduler();
export const projectHealth = keepAliveScheduler;
/** @deprecated use `keepAliveScheduler` / `projectHealth`. */
export const keepAlive = keepAliveScheduler;
