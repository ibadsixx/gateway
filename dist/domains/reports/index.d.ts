export interface Report {
    id: string;
    reporterId: string;
    targetId: string;
    reason: string;
    status: 'PENDING' | 'RESOLVED' | 'DISMISSED';
    createdAt: Date;
}
//# sourceMappingURL=index.d.ts.map