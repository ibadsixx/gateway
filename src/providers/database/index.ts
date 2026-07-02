import { DatabaseProvider } from './types';
import { SupabaseProvider } from './supabaseProvider';
import { PostgresProvider } from './postgresProvider';
import { MongoProvider } from './mongoProvider';

const providers: Record<string, DatabaseProvider> = {
  supabase: new SupabaseProvider(),
  postgres: new PostgresProvider(),
  mongo: new MongoProvider(),
};

export function getDatabaseProvider(name: string): DatabaseProvider {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown database provider: ${name}`);
  }
  return provider;
}

export { DatabaseProvider, SupabaseProvider, PostgresProvider, MongoProvider };
export type { QueryResult } from './types';
