"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.locator = void 0;
class Locator {
    entries = new Map();
    register(entityId, projectId) {
        this.entries.set(entityId, { entityId, projectId });
    }
    locate(entityId) {
        return this.entries.get(entityId)?.projectId;
    }
    unregister(entityId) {
        this.entries.delete(entityId);
    }
}
exports.locator = new Locator();
//# sourceMappingURL=locator.js.map