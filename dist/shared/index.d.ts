export type Domain = 'users' | 'posts' | 'comments' | 'stories' | 'conversations' | 'groups' | 'pages' | 'reports' | 'media' | 'notifications' | 'blocking';
export type ProjectStatus = 'ACTIVE' | 'READ_ONLY' | 'DISABLED' | 'MAINTENANCE';
export interface ApiResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
}
//# sourceMappingURL=index.d.ts.map