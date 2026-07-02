type Permission = string;
type Role = string;
declare class PermissionEngine {
    private policies;
    private userRoles;
    definePolicy(role: Role, permissions: Permission[]): void;
    assignRole(userId: string, role: Role): void;
    revokeRole(userId: string, role: Role): void;
    hasPermission(userId: string, permission: Permission): boolean;
    authorize(userId: string, permission: Permission): void;
}
export declare const permissionEngine: PermissionEngine;
export {};
//# sourceMappingURL=index.d.ts.map