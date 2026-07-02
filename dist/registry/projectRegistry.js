"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectRegistry = void 0;
const databaseRegistry_1 = require("./databaseRegistry");
const storageRegistry_1 = require("./storageRegistry");
class ProjectRegistry {
    async findDatabaseProject(domain) {
        return await databaseRegistry_1.databaseRegistry.getActiveProject(domain);
    }
    async findStorageAccount() {
        return await storageRegistry_1.storageRegistry.getActiveAccount();
    }
    async updateDatabaseStatus(id, status) {
        await databaseRegistry_1.databaseRegistry.updateStatus(id, status);
    }
    async updateStorageUsage(id, usedSpace) {
        await storageRegistry_1.storageRegistry.updateUsage(id, usedSpace);
    }
    async getInfrastructureStatus() {
        const databases = await databaseRegistry_1.databaseRegistry.getAllProjects();
        const storage = await storageRegistry_1.storageRegistry.getAllAccounts();
        return { databases, storage };
    }
}
exports.projectRegistry = new ProjectRegistry();
//# sourceMappingURL=projectRegistry.js.map