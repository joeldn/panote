import { readFileSync } from 'node:fs';

import { parseStackConfig } from './import-file.js';
import { readSettings, type Settings } from './settings.js';

/** The settings a real stack file (`Pulumi.<stack>.yaml`) produces. */
export function stackSettings(stack: 'dev' | 'production'): Settings {
  const yaml = readFileSync(new URL(`../Pulumi.${stack}.yaml`, import.meta.url), 'utf8');
  return readSettings(stack, mapConfig(Object.fromEntries(parseStackConfig(yaml))));
}

/** A `ConfigSource` over a plain map, as `pulumi.Config` would read it. */
export function mapConfig(values: Record<string, string>) {
  return {
    require(key: string): string {
      const value = values[key];
      if (value === undefined) throw new Error(`Missing required configuration variable ${key}`);
      return value;
    },
    getBoolean(key: string): boolean | undefined {
      const value = values[key];
      return value === undefined ? undefined : value === 'true';
    },
  };
}
