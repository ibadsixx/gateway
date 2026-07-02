"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MongoProvider = exports.PostgresProvider = exports.SupabaseProvider = void 0;
exports.getDatabaseProvider = getDatabaseProvider;
const supabaseProvider_1 = require("./supabaseProvider");
Object.defineProperty(exports, "SupabaseProvider", { enumerable: true, get: function () { return supabaseProvider_1.SupabaseProvider; } });
const postgresProvider_1 = require("./postgresProvider");
Object.defineProperty(exports, "PostgresProvider", { enumerable: true, get: function () { return postgresProvider_1.PostgresProvider; } });
const mongoProvider_1 = require("./mongoProvider");
Object.defineProperty(exports, "MongoProvider", { enumerable: true, get: function () { return mongoProvider_1.MongoProvider; } });
const providers = {
    supabase: new supabaseProvider_1.SupabaseProvider(),
    postgres: new postgresProvider_1.PostgresProvider(),
    mongo: new mongoProvider_1.MongoProvider(),
};
function getDatabaseProvider(name) {
    const provider = providers[name];
    if (!provider) {
        throw new Error(`Unknown database provider: ${name}`);
    }
    return provider;
}
//# sourceMappingURL=index.js.map