import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { DatabaseProvider, QueryResult, DatabaseConnectionConfig } from './types';

export class SupabaseProvider implements DatabaseProvider {
  private clients = new Map<string, SupabaseClient>();

  private getClient(config?: DatabaseConnectionConfig): SupabaseClient | null {
    if (!config?.projectUrl || !config?.serviceKey) return null;
    const key = `${config.projectUrl}:${config.serviceKey}`;
    if (!this.clients.has(key)) {
      this.clients.set(key, createClient(config.projectUrl, config.serviceKey));
    }
    return this.clients.get(key)!;
  }

  async create(domain: string, data: Record<string, unknown>, config?: DatabaseConnectionConfig): Promise<QueryResult> {
    const client = this.getClient(config);
    if (!client) {
      console.log(`[Supabase] Creating ${domain} record (no config, using stub)`);
      return { id: crypto.randomUUID(), ...data } as QueryResult;
    }
    const { data: result, error } = await client.from(domain).insert(data).select().single();
    if (error) throw new Error(`Supabase create error: ${error.message}`);
    return result as QueryResult;
  }

  async update(domain: string, id: string, data: Record<string, unknown>, config?: DatabaseConnectionConfig): Promise<QueryResult> {
    const client = this.getClient(config);
    if (!client) {
      console.log(`[Supabase] Updating ${domain}/${id} (no config, using stub)`);
      return { id, ...data } as QueryResult;
    }
    const { data: result, error } = await client.from(domain).update(data).eq('id', id).select().single();
    if (error) throw new Error(`Supabase update error: ${error.message}`);
    return result as QueryResult;
  }

  async delete(domain: string, id: string, config?: DatabaseConnectionConfig): Promise<void> {
    const client = this.getClient(config);
    if (!client) {
      console.log(`[Supabase] Deleting ${domain}/${id} (no config, using stub)`);
      return;
    }
    const { error } = await client.from(domain).delete().eq('id', id);
    if (error) throw new Error(`Supabase delete error: ${error.message}`);
  }

  async find(domain: string, id: string, config?: DatabaseConnectionConfig): Promise<QueryResult | null> {
    const client = this.getClient(config);
    if (!client) {
      console.log(`[Supabase] Finding ${domain}/${id} (no config, using stub)`);
      return null;
    }
    const { data, error } = await client.from(domain).select('*').eq('id', id).single();
    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Supabase find error: ${error.message}`);
    }
    return data as QueryResult;
  }

  async query(domain: string, filter: Record<string, unknown>, config?: DatabaseConnectionConfig): Promise<QueryResult[]> {
    const client = this.getClient(config);
    if (!client) {
      console.log(`[Supabase] Querying ${domain} (no config, using stub)`);
      return [];
    }
    let query = client.from(domain).select('*');
    for (const [key, value] of Object.entries(filter)) {
      if (value === null) {
        query = query.is(key, null);
      } else {
        query = query.eq(key, value);
      }
    }
    const { data, error } = await query;
    if (error) throw new Error(`Supabase query error: ${error.message}`);
    return (data as QueryResult[]) || [];
  }
}
