"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.featureFlags = void 0;
class FeatureFlags {
    flags = new Map();
    enable(name) {
        this.flags.set(name, true);
    }
    disable(name) {
        this.flags.set(name, false);
    }
    isEnabled(name) {
        return this.flags.get(name) ?? false;
    }
    getAll() {
        const result = {};
        for (const [name, enabled] of this.flags) {
            result[name] = enabled;
        }
        return result;
    }
}
exports.featureFlags = new FeatureFlags();
//# sourceMappingURL=index.js.map