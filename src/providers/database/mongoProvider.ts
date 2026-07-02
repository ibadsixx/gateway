import { DatabaseProvider, QueryResult, DatabaseConnectionConfig } from './types';

export class MongoProvider implements DatabaseProvider {
  async create(domain: string, data: Record<string, unknown>, _config?: DatabaseConnectionConfig): Promise<QueryResult> {
    console.log(`[MongoDB] Creating ${domain} document`);
    return { id: crypto.randomUUID(), ...data };
  }

  async update(domain: string, id: string, data: Record<string, unknown>, _config?: DatabaseConnectionConfig): Promise<QueryResult> {
    console.log(`[MongoDB] Updating ${domain}/${id}`);
    return { id, ...data };
  }

  async delete(domain: string, id: string, _config?: DatabaseConnectionConfig): Promise<void> {
    console.log(`[MongoDB] Deleting ${domain}/${id}`);
  }

  async find(domain: string, id: string, _config?: DatabaseConnectionConfig): Promise<QueryResult | null> {
    console.log(`[MongoDB] Finding ${domain}/${id}`);
    return null;
  }

  async query(domain: string, filter: Record<string, unknown>, _config?: DatabaseConnectionConfig): Promise<QueryResult[]> {
    console.log(`[MongoDB] Querying ${domain} with`, filter);
    return [];
  }
}
