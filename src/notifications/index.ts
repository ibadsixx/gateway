import { sleep } from '../utils';

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

interface QueuedNotification extends Notification {
  attempts: number;
  nextAttemptAt: number;
}

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_WAIT_MS = 30000;
const MAX_DEAD_LETTERS = 100;

class NotificationQueue {
  private queue: QueuedNotification[] = [];
  private deadLetters: Notification[] = [];
  private processing = false;

  enqueue(notification: Omit<Notification, 'id' | 'createdAt'>): Notification {
    const notif: QueuedNotification = {
      ...notification,
      id: crypto.randomUUID(),
      createdAt: new Date(),
      attempts: 0,
      nextAttemptAt: Date.now(),
    };
    this.queue.push(notif);
    this.processNext();
    return notif;
  }

  private async processNext(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const now = Date.now();
        const dueIndex = this.queue.findIndex(n => n.nextAttemptAt <= now);
        if (dueIndex === -1) {
          const nextAt = Math.min(...this.queue.map(n => n.nextAttemptAt));
          await sleep(Math.min(nextAt - now, MAX_WAIT_MS));
          continue;
        }

        const [notification] = this.queue.splice(dueIndex, 1);
        try {
          await this.send(notification);
          notification.sentAt = new Date();
        } catch (error) {
          notification.attempts += 1;
          if (notification.attempts >= MAX_ATTEMPTS) {
            console.error(`Notification ${notification.id} dead-lettered after ${notification.attempts} attempts`, error);
            this.deadLetters.push(notification);
            if (this.deadLetters.length > MAX_DEAD_LETTERS) {
              this.deadLetters.shift();
            }
          } else {
            const delay = BASE_DELAY_MS * Math.pow(2, notification.attempts - 1);
            notification.nextAttemptAt = Date.now() + delay;
            this.queue.push(notification);
            console.warn(`Notification ${notification.id} failed, retrying in ${delay}ms (attempt ${notification.attempts}/${MAX_ATTEMPTS})`);
          }
        }
      }
    } finally {
      this.processing = false;
    }
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

  get deadLetterCount(): number {
    return this.deadLetters.length;
  }
}

export const notificationQueue = new NotificationQueue();
