"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configCenter = void 0;
const infrastructureDb_1 = require("../infrastructure/database/infrastructureDb");
class ConfigurationCenter {
    cache = new Map();
    loaded = false;
    async ensureLoaded() {
        if (this.loaded)
            return;
        const settings = await infrastructureDb_1.infrastructureDb.getAllSettings();
        for (const setting of settings) {
            const val = setting.value;
            this.cache.set(setting.key, {
                value: val?.value ?? setting.value,
                type: setting.type,
                updatedAt: new Date(setting.updated_at),
            });
        }
        this.loaded = true;
    }
    async set(key, value, type = 'string') {
        const dbType = type;
        await infrastructureDb_1.infrastructureDb.setSetting(key, value, dbType);
        this.cache.set(key, { value, type, updatedAt: new Date() });
        this.notifyWatchers(key, value);
    }
    get(key, defaultValue) {
        return this.cache.get(key)?.value ?? defaultValue;
    }
    watch(key, callback) {
        infrastructureDb_1.infrastructureDb.watchSetting(key, callback);
    }
    async getAll() {
        const result = {};
        for (const [key, config] of this.cache) {
            result[key] = config.value;
        }
        return result;
    }
    watchers = new Map();
    notifyWatchers(key, value) {
        const watchers = this.watchers.get(key);
        if (watchers) {
            for (const watcher of watchers) {
                watcher(value);
            }
        }
    }
}
exports.configCenter = new ConfigurationCenter();
//# sourceMappingURL=index.js.map