"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.database = void 0;
const service_1 = require("../../routing/service");
class DatabaseLayer {
    async read(domain, id) {
        return service_1.routingService.read(domain, id);
    }
    async write(domain, data) {
        return service_1.routingService.write(domain, data);
    }
    async update(domain, id, data) {
        return service_1.routingService.update(domain, id, data);
    }
    async delete(domain, id, permanent = false) {
        return service_1.routingService.delete(domain, id, permanent);
    }
    async query(domain, filter) {
        return service_1.routingService.query(domain, filter);
    }
}
exports.database = new DatabaseLayer();
//# sourceMappingURL=index.js.map