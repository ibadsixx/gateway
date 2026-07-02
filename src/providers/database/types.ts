export interface QueryResult {
  id: string;
  [key: string]: unknown;
}

export interface DatabaseConnectionConfig {
  projectUrl: string;
  serviceKey: string;
  anonKey: string;
}

export interface DatabaseProvider {
  create(domain: string, data: Record<string, unknown>, config?: DatabaseConnectionConfig): Promise<QueryResult>;
  update(domain: string, id: string, data: Record<string, unknown>, config?: DatabaseConnectionConfig): Promise<QueryResult>;
  delete(domain: string, id: string, config?: DatabaseConnectionConfig): Promise<void>;
  find(domain: string, id: string, config?: DatabaseConnectionConfig): Promise<QueryResult | null>;
  query(domain: string, filter: Record<string, unknown>, config?: DatabaseConnectionConfig): Promise<QueryResult[]>;
}

export function connectionConfigFromProject(project: { project_url?: string; service_key?: string; anon_key?: string; projectUrl?: string; serviceKey?: string; anonKey?: string }): DatabaseConnectionConfig | undefined {
  const url = project.projectUrl || project.project_url;
  const key = project.serviceKey || project.service_key;
  const anon = project.anonKey || project.anon_key || '';
  if (url && key) {
    return { projectUrl: url, serviceKey: key, anonKey: anon };
  }
  return undefined;
}
