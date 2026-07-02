"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationQueue = void 0;
class NotificationQueue {
    queue = [];
    processing = false;
    enqueue(notification) {
        const notif = {
            ...notification,
            id: crypto.randomUUID(),
            createdAt: new Date(),
        };
        this.queue.push(notif);
        this.processNext();
        return notif;
    }
    async processNext() {
        if (this.processing)
            return;
        this.processing = true;
        while (this.queue.length > 0) {
            const notification = this.queue.shift();
            try {
                await this.send(notification);
                notification.sentAt = new Date();
            }
            catch (error) {
                console.error(`Failed to send notification ${notification.id}`, error);
                this.queue.push(notification);
            }
        }
        this.processing = false;
    }
    async send(notification) {
        switch (notification.type) {
            case 'PUSH':
                console.log(`[Push] Sending to ${notification.userId}: ${notification.title}`);
                break;
            case 'EMAIL':
                console.log(`[Email] Sending to ${notification.userId}: ${notification.title}`);
                break;
            case 'IN_APP':
                console.log(`[InApp] Sending to ${notification.userId}: ${notification.title}`);
                break;
        }
    }
    get length() {
        return this.queue.length;
    }
}
exports.notificationQueue = new NotificationQueue();
//# sourceMappingURL=index.js.map