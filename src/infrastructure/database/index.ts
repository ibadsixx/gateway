import { routingService } from '../../routing/service';
import type { QueryResult } from '../../routing/service';

class DatabaseLayer {
  async read(domain: string, id: string): Promise<QueryResult | null> {
    return routingService.read(domain, id);
  }

  async write(domain: string, data: Record<string, unknown>): Promise<QueryResult> {
    return routingService.write(domain, data);
  }

  async update(domain: string, id: string, data: Record<string, unknown>): Promise<QueryResult> {
    return routingService.update(domain, id, data);
  }

  async delete(domain: string, id: string, permanent = false): Promise<void> {
    return routingService.delete(domain, id, permanent);
  }

  async query(domain: string, filter: Record<string, unknown>): Promise<QueryResult[]> {
    return routingService.query(domain, filter);
  }
}

export const database = new DatabaseLayer();
