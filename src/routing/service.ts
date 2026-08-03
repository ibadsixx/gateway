import { projectManager } from '../project-manager';
import { eventBus } from '../events/bus';
import { metricsService } from '../metrics';
import { RetryEngine } from '../retry/engine';

export interface QueryResult {
  id: string;
  [key: string]: unknown;
}

class RoutingService {
  write(domain: string, data: Record<string, unknown>): Promise<QueryResult> {
    const start = Date.now();
    const entry = projectManager.getWritableProject(domain);
    if (!entry) {
      return Promise.reject(new Error(`No writable project for domain: ${domain}`));
    }
    const { client } = entry;

    return RetryEngine.execute(async () => {
      const { _on_conflict, ...payload } = data;
      let inserted: unknown;
      if (typeof _on_conflict === 'string' && _on_conflict.length > 0) {
        const { data: upserted, error } = await client.from(domain).upsert(payload, { onConflict: _on_conflict }).select().single();
        if (error) return Promise.reject(new Error(`Upsert error: ${error.message}`));
        inserted = upserted;
      } else {
        const { data: created, error } = await client.from(domain).insert(payload).select().single();
        if (error) return Promise.reject(new Error(`Insert error: ${error.message}`));
        inserted = created;
      }
      const result = inserted as QueryResult;

      eventBus.emit({
        type: `${domain}.created`,
        payload: { id: result.id, data },
        metadata: { timestamp: new Date(), source: 'routing-service' },
      });

      metricsService.record('db.write.duration', Date.now() - start, { domain });
      return result;
    });
  }

  read(domain: string, id: string): Promise<QueryResult | null> {
    const start = Date.now();
    const entry = projectManager.getReadClient(domain, id);
    const { client } = entry;

    return RetryEngine.execute(async () => {
      const { data, error } = await client.from(domain).select('*').eq('id', id).single();
      if (error) {
        if ((error as { code?: string }).code === 'PGRST116') return null;
        return Promise.reject(new Error(`Read error: ${error.message}`));
      }
      metricsService.record('db.read.duration', Date.now() - start, { domain });
      return data as QueryResult;
    });
  }

  update(domain: string, id: string, data: Record<string, unknown>): Promise<QueryResult> {
    const start = Date.now();
    const entry = projectManager.getReadClient(domain, id);
    const { client } = entry;

    return RetryEngine.execute(async () => {
      const { data: updated, error } = await client.from(domain).update(data).eq('id', id).select().single();
      if (error) return Promise.reject(new Error(`Update error: ${error.message}`));

      eventBus.emit({
        type: `${domain}.updated`,
        payload: { id, data },
        metadata: { timestamp: new Date(), source: 'routing-service' },
      });

      metricsService.record('db.update.duration', Date.now() - start, { domain });
      return updated as QueryResult;
    });
  }

  delete(domain: string, id: string, permanent = false): Promise<void> {
    const start = Date.now();

    const doDelete = (): Promise<void> => {
      const entry = projectManager.getReadClient(domain, id);
      const { client } = entry;

      return RetryEngine.execute(async () => {
        if (permanent) {
          const { error } = await client.from(domain).delete().eq('id', id);
          if (error) return Promise.reject(new Error(`Delete error: ${error.message}`));
        } else {
          const { error } = await client.from(domain).update({ deletedAt: new Date() }).eq('id', id);
          if (error) return Promise.reject(new Error(`Soft delete error: ${error.message}`));
        }

        eventBus.emit({
          type: `${domain}.deleted`,
          payload: { id, permanent },
          metadata: { timestamp: new Date(), source: 'routing-service' },
        });

        metricsService.record('db.delete.duration', Date.now() - start, { domain });
      });
    };

    return doDelete();
  }

  query(domain: string, filter: Record<string, unknown>): Promise<QueryResult[]> {
    const entry = projectManager.getWritableProject(domain);
    if (!entry) {
      return Promise.reject(new Error(`No writable project for domain: ${domain}`));
    }
    const { client } = entry;

    return RetryEngine.execute(async () => {
      let query = client.from(domain).select('*');
      for (const [key, value] of Object.entries(filter)) {
        if (value === null) {
          query = query.is(key, null);
        } else {
          query = query.eq(key, value);
        }
      }
      const { data, error } = await query;
      if (error) return Promise.reject(new Error(`Query error: ${error.message}`));
      return (data as QueryResult[]) || [];
    });
  }
}

export const routingService = new RoutingService();
