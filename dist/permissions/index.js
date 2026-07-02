"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.permissionEngine = void 0;
class PermissionEngine {
    policies = new Map();
    userRoles = new Map();
    definePolicy(role, permissions) {
        this.policies.set(role, { role, permissions: new Set(permissions) });
    }
    assignRole(userId, role) {
        if (!this.userRoles.has(userId)) {
            this.userRoles.set(userId, new Set());
        }
        this.userRoles.get(userId).add(role);
    }
    revokeRole(userId, role) {
        this.userRoles.get(userId)?.delete(role);
    }
    hasPermission(userId, permission) {
        const roles = this.userRoles.get(userId);
        if (!roles)
            return false;
        for (const role of roles) {
            const policy = this.policies.get(role);
            if (policy?.permissions.has(permission))
                return true;
        }
        return false;
    }
    authorize(userId, permission) {
        if (!this.hasPermission(userId, permission)) {
            throw new Error(`Permission denied: ${permission}`);
        }
    }
}
exports.permissionEngine = new PermissionEngine();
//# sourceMappingURL=index.js.map