import { infrastructureDb } from '../infrastructure/database/infrastructureDb';
import type { InfrastructureProjectRow } from '../db/schema';

export type KeepAliveState = 'active' | 'unreachable' | 'unknown' | 'excluded';

interface ProjectStatus {
  state: KeepAliveState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  online: number;
  unreachable: number;
}

const PROBE_TIMEOUT_MS = 10000;
const MAX_CONCURRENCY = 5;
const DEFAULT_INTERVAL_HOURS = 24;

function intervalHoursFromEnv(): number {
  const raw = Number(process.env.KEEP_ALIVE_INTERVAL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_HOURS;
}

class KeepAliveService {
  private statuses = new Map<string, ProjectStatus>();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  async runOnce(): Promise<RunSummary | { skipped: 'already-running' }> {
    if (this.running) return { skipped: 'already-running' };
    this.running = true;

    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    try {
      const projects = await infrastructureDb.getProjects();
      const targets = projects.filter(p => p.status === 'active' && !!p.project_url);
      let online = 0;
      let unreachable = 0;

      for (let i = 0; i < targets.length; i += MAX_CONCURRENCY) {
        const results = await Promise.all(
          targets.slice(i, i + MAX_CONCURRENCY).map(p => this.probe(p)),
        );
        for (const ok of results) {
          if (ok) online++;
          else unreachable++;
        }
      }

      return {
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        total: targets.length,
        online,
        unreachable,
      };
    } finally {
      this.running = false;
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
    } catch (err) {
      console.error(`[KeepAlive] Failed to persist failure for ${project.project_key}:`, (err as Error).message);
    }
  }

  async getStatus(): Promise<{
    generatedAt: string;
    intervalHours: number;
    schedulerRunning: boolean;
    projects: Array<Record<string, unknown>>;
  }> {
    const projects = await infrastructureDb.getProjects();
    return {
      generatedAt: new Date().toISOString(),
      intervalHours: intervalHoursFromEnv(),
      schedulerRunning: this.timer !== null,
      projects: projects.map(p => {
        const mem = this.statuses.get(p.id);
        return {
          project_key: p.project_key,
          domain: p.domain,
          registry_status: p.status,
          state: p.status !== 'active' ? 'excluded' : mem?.state ?? 'unknown',
          last_attempt_at: mem?.lastAttemptAt ?? null,
          last_success_at: mem?.lastSuccessAt ?? p.last_health_check,
          last_failure_at: mem?.lastFailureAt ?? null,
          latency_ms: mem?.latencyMs ?? p.response_time,
          consecutive_failures: mem?.consecutiveFailures ?? 0,
          last_error: mem?.lastError ?? null,
        };
      }),
    };
  }

  getHistory(projectKey: string, limit = 20) {
    return infrastructureDb.getHealthLogs('database', projectKey, limit);
  }

  start(): void {
    if (this.timer) return;
    const ms = intervalHoursFromEnv() * 60 * 60 * 1000;
    this.timer = setInterval(() => {
      this.runOnce().catch(err =>
        console.error('[KeepAlive] Scheduled round failed:', (err as Error).message),
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

export const keepAlive = new KeepAliveService();
