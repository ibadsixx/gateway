"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupabaseProvider = void 0;
const client_factory_1 = require("../../client-factory");
class SupabaseProvider {
    getClient(config) {
        if (!config?.projectUrl || !config?.serviceKey)
            return null;
        return client_factory_1.clientFactory.getClient({
            projectUrl: config.projectUrl,
            serviceKey: config.serviceKey,
        });
    }
    async create(domain, data, config) {
        const client = this.getClient(config);
        if (!client) {
            console.log(`[Supabase] Creating ${domain} record (no config, using stub)`);
            return { id: crypto.randomUUID(), ...data };
        }
        const { data: result, error } = await client.from(domain).insert(data).select().single();
        if (error)
            throw new Error(`Supabase create error: ${error.message}`);
        return result;
    }
    async update(domain, id, data, config) {
        const client = this.getClient(config);
        if (!client) {
            console.log(`[Supabase] Updating ${domain}/${id} (no config, using stub)`);
            return { id, ...data };
        }
        const { data: result, error } = await client.from(domain).update(data).eq('id', id).select().single();
        if (error)
            throw new Error(`Supabase update error: ${error.message}`);
        return result;
    }
    async delete(domain, id, config) {
        const client = this.getClient(config);
        if (!client) {
            console.log(`[Supabase] Deleting ${domain}/${id} (no config, using stub)`);
            return;
        }
        const { error } = await client.from(domain).delete().eq('id', id);
        if (error)
            throw new Error(`Supabase delete error: ${error.message}`);
    }
    async find(domain, id, config) {
        const client = this.getClient(config);
        if (!client) {
            console.log(`[Supabase] Finding ${domain}/${id} (no config, using stub)`);
            return null;
        }
        const { data, error } = await client.from(domain).select('*').eq('id', id).single();
        if (error) {
            if (error.code === 'PGRST116')
                return null;
            throw new Error(`Supabase find error: ${error.message}`);
        }
        return data;
    }
    async query(domain, filter, config) {
        const client = this.getClient(config);
        if (!client) {
            console.log(`[Supabase] Querying ${domain} (no config, using stub)`);
            return [];
        }
        let query = client.from(domain).select('*');
        for (const [key, value] of Object.entries(filter)) {
            if (value === null) {
                query = query.is(key, null);
            }
            else {
                query = query.eq(key, value);
            }
        }
        const { data, error } = await query;
        if (error)
            throw new Error(`Supabase query error: ${error.message}`);
        return data || [];
    }
}
exports.SupabaseProvider = SupabaseProvider;
//# sourceMappingURL=supabaseProvider.js.map