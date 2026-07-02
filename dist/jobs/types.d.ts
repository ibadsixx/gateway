export interface Job {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    priority: number;
    retries: number;
    maxRetries: number;
    status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
    createdAt: Date;
    updatedAt: Date;
}
//# sourceMappingURL=types.d.ts.map