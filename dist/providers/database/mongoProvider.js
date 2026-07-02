"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MongoProvider = void 0;
class MongoProvider {
    async create(domain, data, _config) {
        console.log(`[MongoDB] Creating ${domain} document`);
        return { id: crypto.randomUUID(), ...data };
    }
    async update(domain, id, data, _config) {
        console.log(`[MongoDB] Updating ${domain}/${id}`);
        return { id, ...data };
    }
    async delete(domain, id, _config) {
        console.log(`[MongoDB] Deleting ${domain}/${id}`);
    }
    async find(domain, id, _config) {
        console.log(`[MongoDB] Finding ${domain}/${id}`);
        return null;
    }
    async query(domain, filter, _config) {
        console.log(`[MongoDB] Querying ${domain} with`, filter);
        return [];
    }
}
exports.MongoProvider = MongoProvider;
//# sourceMappingURL=mongoProvider.js.map