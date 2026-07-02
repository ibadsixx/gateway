interface RoutingEntry {
  entityId: string;
  projectId: string;
}

class Locator {
  private entries: Map<string, RoutingEntry> = new Map();

  register(entityId: string, projectId: string): void {
    this.entries.set(entityId, { entityId, projectId });
  }

  locate(entityId: string): string | undefined {
    return this.entries.get(entityId)?.projectId;
  }

  unregister(entityId: string): void {
    this.entries.delete(entityId);
  }
}

export const locator = new Locator();
