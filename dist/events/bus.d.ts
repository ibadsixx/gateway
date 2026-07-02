import { Event } from './types';
type EventHandler = (event: Event) => void | Promise<void>;
declare class EventBus {
    private handlers;
    on(eventType: string, handler: EventHandler): void;
    off(eventType: string, handler: EventHandler): void;
    emit(event: Event): Promise<void>;
    clear(): void;
}
export declare const eventBus: EventBus;
export {};
//# sourceMappingURL=bus.d.ts.map