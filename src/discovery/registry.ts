interface ServiceInstance {
  name: string;
  version: string;
  endpoint: string;
  healthUrl: string;
  registeredAt: Date;
  lastHeartbeat: Date;
  metadata: Record<string, string>;
}

class ServiceDiscovery {
  private services: Map<string, ServiceInstance[]> = new Map();

  register(instance: ServiceInstance): void {
    const existing = this.services.get(instance.name) || [];
    const idx = existing.findIndex(s => s.endpoint === instance.endpoint);
    if (idx >= 0) {
      existing[idx] = instance;
    } else {
      existing.push(instance);
    }
    this.services.set(instance.name, existing);
  }

  unregister(name: string, endpoint: string): void {
    const existing = this.services.get(name);
    if (!existing) return;
    this.services.set(
      name,
      existing.filter(s => s.endpoint !== endpoint),
    );
  }

  discover(name: string): ServiceInstance[] {
    const instances = this.services.get(name) || [];
    const now = Date.now();
    return instances.filter(s => now - s.lastHeartbeat.getTime() < 30000);
  }

  heartbeat(name: string, endpoint: string): boolean {
    const existing = this.services.get(name);
    if (!existing) return false;
    const instance = existing.find(s => s.endpoint === endpoint);
    if (!instance) return false;
    instance.lastHeartbeat = new Date();
    return true;
  }

  getAllServices(): Record<string, ServiceInstance[]> {
    const result: Record<string, ServiceInstance[]> = {};
    for (const [name, instances] of this.services) {
      result[name] = this.discover(name);
    }
    return result;
  }
}

export const serviceDiscovery = new ServiceDiscovery();
export type { ServiceInstance };
