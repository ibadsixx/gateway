"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.routingService = void 0;
const databaseRegistry_1 = require("../registry/databaseRegistry");
class RoutingService {
    async getWritableProject(domain) {
        const project = await databaseRegistry_1.databaseRegistry.getWritableProject(domain);
        if (!project) {
            throw new Error(`No writable project found for domain: ${domain}`);
        }
        return project;
    }
}
exports.routingService = new RoutingService();
//# sourceMappingURL=service.js.map