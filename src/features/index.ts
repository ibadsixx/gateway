class FeatureFlags {
  private flags: Map<string, boolean> = new Map();

  enable(name: string): void {
    this.flags.set(name, true);
  }

  disable(name: string): void {
    this.flags.set(name, false);
  }

  isEnabled(name: string): boolean {
    return this.flags.get(name) ?? false;
  }

  getAll(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const [name, enabled] of this.flags) {
      result[name] = enabled;
    }
    return result;
  }
}

export const featureFlags = new FeatureFlags();
