type Permission = string;
type Role = string;

interface Policy {
  role: Role;
  permissions: Set<Permission>;
}

class PermissionEngine {
  private policies: Map<Role, Policy> = new Map();
  private userRoles: Map<string, Set<Role>> = new Map();

  definePolicy(role: Role, permissions: Permission[]): void {
    this.policies.set(role, { role, permissions: new Set(permissions) });
  }

  assignRole(userId: string, role: Role): void {
    if (!this.userRoles.has(userId)) {
      this.userRoles.set(userId, new Set());
    }
    this.userRoles.get(userId)!.add(role);
  }

  revokeRole(userId: string, role: Role): void {
    this.userRoles.get(userId)?.delete(role);
  }

  hasPermission(userId: string, permission: Permission): boolean {
    const roles = this.userRoles.get(userId);
    if (!roles) return false;
    for (const role of roles) {
      const policy = this.policies.get(role);
      if (policy?.permissions.has(permission)) return true;
    }
    return false;
  }

  authorize(userId: string, permission: Permission): void {
    if (!this.hasPermission(userId, permission)) {
      throw new Error(`Permission denied: ${permission}`);
    }
  }
}

export const permissionEngine = new PermissionEngine();
