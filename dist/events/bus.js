"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventBus = void 0;
class EventBus {
    handlers = new Map();
    on(eventType, handler) {
        if (!this.handlers.has(eventType)) {
            this.handlers.set(eventType, new Set());
        }
        this.handlers.get(eventType).add(handler);
    }
    off(eventType, handler) {
        this.handlers.get(eventType)?.delete(handler);
    }
    async emit(event) {
        const handlers = this.handlers.get(event.type);
        if (!handlers)
            return;
        const promises = [];
        for (const handler of handlers) {
            const result = handler(event);
            if (result instanceof Promise) {
                promises.push(result);
            }
        }
        await Promise.allSettled(promises);
    }
    clear() {
        this.handlers.clear();
    }
}
exports.eventBus = new EventBus();
//# sourceMappingURL=bus.js.map