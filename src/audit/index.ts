interface AuditEntry {
  userId: string;
  action: string;
  resource: string;
  resourceId?: string;
  ip: string;
  duration: number;
  status: 'SUCCESS' | 'FAILURE';
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

class AuditLogger {
  private entries: AuditEntry[] = [];

  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    const full: AuditEntry = { ...entry, timestamp: new Date() };
    this.entries.push(full);
    console.log(`[AUDIT] ${full.action} on ${full.resource} by ${full.userId} - ${full.status}`);
  }

  query(filter: Partial<AuditEntry>): AuditEntry[] {
    return this.entries.filter(entry => {
      for (const [key, value] of Object.entries(filter)) {
        if ((entry as unknown as Record<string, unknown>)[key] !== value) return false;
      }
      return true;
    });
  }

  getAll(): AuditEntry[] {
    return [...this.entries];
  }
}

export const auditLogger = new AuditLogger();
