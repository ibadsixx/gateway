interface Notification {
    id: string;
    userId: string;
    type: 'PUSH' | 'EMAIL' | 'IN_APP';
    title: string;
    body: string;
    payload?: Record<string, unknown>;
    createdAt: Date;
    sentAt?: Date;
}
declare class NotificationQueue {
    private queue;
    private processing;
    enqueue(notification: Omit<Notification, 'id' | 'createdAt'>): Notification;
    private processNext;
    private send;
    get length(): number;
}
export declare const notificationQueue: NotificationQueue;
export {};
//# sourceMappingURL=index.d.ts.map