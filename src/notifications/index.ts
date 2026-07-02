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

class NotificationQueue {
  private queue: Notification[] = [];
  private processing = false;

  enqueue(notification: Omit<Notification, 'id' | 'createdAt'>): Notification {
    const notif: Notification = {
      ...notification,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    this.queue.push(notif);
    this.processNext();
    return notif;
  }

  private async processNext(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const notification = this.queue.shift()!;
      try {
        await this.send(notification);
        notification.sentAt = new Date();
      } catch (error) {
        console.error(`Failed to send notification ${notification.id}`, error);
        this.queue.push(notification);
      }
    }

    this.processing = false;
  }

  private async send(notification: Notification): Promise<void> {
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

  get length(): number {
    return this.queue.length;
  }
}

export const notificationQueue = new NotificationQueue();
