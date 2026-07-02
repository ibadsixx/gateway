"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLogger = void 0;
class AuditLogger {
    entries = [];
    log(entry) {
        const full = { ...entry, timestamp: new Date() };
        this.entries.push(full);
        console.log(`[AUDIT] ${full.action} on ${full.resource} by ${full.userId} - ${full.status}`);
    }
    query(filter) {
        return this.entries.filter(entry => {
            for (const [key, value] of Object.entries(filter)) {
                if (entry[key] !== value)
                    return false;
            }
            return true;
        });
    }
    getAll() {
        return [...this.entries];
    }
}
exports.auditLogger = new AuditLogger();
//# sourceMappingURL=index.js.map