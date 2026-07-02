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
declare class AuditLogger {
    private entries;
    log(entry: Omit<AuditEntry, 'timestamp'>): void;
    query(filter: Partial<AuditEntry>): AuditEntry[];
    getAll(): AuditEntry[];
}
export declare const auditLogger: AuditLogger;
export {};
//# sourceMappingURL=index.d.ts.map