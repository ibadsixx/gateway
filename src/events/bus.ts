import { Event } from './types';

type EventHandler = (event: Event) => void | Promise<void>;

class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();

  on(eventType: string, handler: EventHandler): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
  }

  off(eventType: string, handler: EventHandler): void {
    this.handlers.get(eventType)?.delete(handler);
  }

  async emit(event: Event): Promise<void> {
    const handlers = this.handlers.get(event.type);
    if (!handlers) return;
    const promises: Promise<void>[] = [];
    for (const handler of handlers) {
      const result = handler(event);
      if (result instanceof Promise) {
        promises.push(result);
      }
    }
    await Promise.allSettled(promises);
  }

  clear(): void {
    this.handlers.clear();
  }
}

export const eventBus = new EventBus();
