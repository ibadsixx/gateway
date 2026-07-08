"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clientFactory = void 0;
const supabase_js_1 = require("@supabase/supabase-js");
class ClientFactory {
    clients = new Map();
    buildKey(config) {
        return `${config.projectUrl}:${config.serviceKey}`;
    }
    getClient(config) {
        const key = this.buildKey(config);
        if (!this.clients.has(key)) {
            this.clients.set(key, (0, supabase_js_1.createClient)(config.projectUrl, config.serviceKey));
        }
        return this.clients.get(key);
    }
    getClientFromProject(project) {
        return this.getClient({
            projectUrl: project.projectUrl,
            serviceKey: project.serviceKey,
        });
    }
    removeClient(config) {
        this.clients.delete(this.buildKey(config));
    }
    clear() {
        this.clients.clear();
    }
    get size() {
        return this.clients.size;
    }
}
exports.clientFactory = new ClientFactory();
//# sourceMappingURL=index.js.map