import { infrastructureDb } from '../infrastructure/database/infrastructureDb';
import type { SettingType } from '../db/schema';

interface ConfigValue {
  value: unknown;
  type: 'string' | 'number' | 'boolean' | 'json';
  updatedAt: Date;
}

class ConfigurationCenter {
  private cache: Map<string, ConfigValue> = new Map();
  private loaded = false;

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const settings = await infrastructureDb.getAllSettings();
    for (const setting of settings) {
      const val = setting.value as Record<string, unknown>;
      this.cache.set(setting.key, {
        value: val?.value ?? setting.value,
        type: setting.type as ConfigValue['type'],
        updatedAt: new Date(setting.updated_at),
      });
    }
    this.loaded = true;
  }

  async set(key: string, value: unknown, type: ConfigValue['type'] = 'string'): Promise<void> {
    const dbType = type as SettingType;
    await infrastructureDb.setSetting(key, value, dbType);
    this.cache.set(key, { value, type, updatedAt: new Date() });
    this.notifyWatchers(key, value);
  }

  get<T = unknown>(key: string, defaultValue?: T): T {
    return (this.cache.get(key)?.value as T) ?? defaultValue as T;
  }

  watch(key: string, callback: (value: unknown) => void): void {
    infrastructureDb.watchSetting(key, callback);
  }

  async getAll(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const [key, config] of this.cache) {
      result[key] = config.value;
    }
    return result;
  }

  private watchers: Map<string, Set<(value: unknown) => void>> = new Map();

  private notifyWatchers(key: string, value: unknown): void {
    const watchers = this.watchers.get(key);
    if (watchers) {
      for (const watcher of watchers) {
        watcher(value);
      }
    }
  }
}

export const configCenter = new ConfigurationCenter();
