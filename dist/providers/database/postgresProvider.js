"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostgresProvider = void 0;
class PostgresProvider {
    async create(domain, data, _config) {
        console.log(`[PostgreSQL] Creating ${domain} record`);
        return { id: crypto.randomUUID(), ...data };
    }
    async update(domain, id, data, _config) {
        console.log(`[PostgreSQL] Updating ${domain}/${id}`);
        return { id, ...data };
    }
    async delete(domain, id, _config) {
        console.log(`[PostgreSQL] Deleting ${domain}/${id}`);
    }
    async find(domain, id, _config) {
        console.log(`[PostgreSQL] Finding ${domain}/${id}`);
        return null;
    }
    async query(domain, filter, _config) {
        console.log(`[PostgreSQL] Querying ${domain} with`, filter);
        return [];
    }
}
exports.PostgresProvider = PostgresProvider;
//# sourceMappingURL=postgresProvider.js.map