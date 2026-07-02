"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serviceDiscovery = void 0;
class ServiceDiscovery {
    services = new Map();
    register(instance) {
        const existing = this.services.get(instance.name) || [];
        const idx = existing.findIndex(s => s.endpoint === instance.endpoint);
        if (idx >= 0) {
            existing[idx] = instance;
        }
        else {
            existing.push(instance);
        }
        this.services.set(instance.name, existing);
    }
    unregister(name, endpoint) {
        const existing = this.services.get(name);
        if (!existing)
            return;
        this.services.set(name, existing.filter(s => s.endpoint !== endpoint));
    }
    discover(name) {
        const instances = this.services.get(name) || [];
        const now = Date.now();
        return instances.filter(s => now - s.lastHeartbeat.getTime() < 30000);
    }
    heartbeat(name, endpoint) {
        const existing = this.services.get(name);
        if (!existing)
            return false;
        const instance = existing.find(s => s.endpoint === endpoint);
        if (!instance)
            return false;
        instance.lastHeartbeat = new Date();
        return true;
    }
    getAllServices() {
        const result = {};
        for (const [name, instances] of this.services) {
            result[name] = this.discover(name);
        }
        return result;
    }
}
exports.serviceDiscovery = new ServiceDiscovery();
//# sourceMappingURL=registry.js.map