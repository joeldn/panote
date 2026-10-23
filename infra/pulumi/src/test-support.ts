import { readFileSync } from 'node:fs';

import * as pulumi from '@pulumi/pulumi';
import { expect } from 'vitest';

import { DATABASE_CONNECTION, type Auth0Secrets } from './auth0.js';
import { settingsFromStackFile } from './import-file.js';
import type { Infra } from './infra.js';
import { RESOURCES, type ResourceKey } from './names.js';
import type { Settings } from './settings.js';

/** The settings a real stack file (`Pulumi.<stack>.yaml`) produces. */
export function stackSettings(stack: 'dev' | 'production'): Settings {
  const yaml = readFileSync(new URL(`../Pulumi.${stack}.yaml`, import.meta.url), 'utf8');
  return settingsFromStackFile(stack, yaml);
}

/** A `ConfigSource` over a plain map, as `pulumi.Config` would read it. */
export function mapConfig(values: Record<string, string>) {
  return {
    get(key: string): string | undefined {
      return values[key];
    },
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

/** What a run of the program looks like to Pulumi's mocks (no engine, no provider). */
export interface Registered {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}

export const ZONE_IDS: Record<string, string> = {
  'panote.dev': '2196d8dead0322ad69307711fc72b5d3',
  'panote.io': '0123456789abcdef0123456789abcdef',
};

/** The id the mocked `getConnection` gives the tenant's password database. */
export const DATABASE_CONNECTION_ID = 'con_database';

/** Every resource the mocked engine saw, by logical name, per run. */
let registered = new Map<string, Registered>();

/**
 * Installs the mocks once per test file. Outputs a provider computes are
 * given stand-ins: a queue's id, a client's id and secret.
 */
export async function installMocks(): Promise<void> {
  await pulumi.runtime.setMocks(
    {
      newResource(args) {
        registered.set(args.name, { type: args.type, name: args.name, inputs: args.inputs });
        const state: Record<string, unknown> = { ...args.inputs };
        if (args.type === RESOURCES.uploadsQueue.type) state.queueId = `${args.name}-queue-id`;
        if (args.type === RESOURCES.spaClient.type) state.clientId = `${args.name}-client-id`;
        if (args.type === RESOURCES.linkingCredentials.type) {
          state.clientSecret = `${args.name}-secret`;
        }
        return { id: `${args.name}-id`, state };
      },
      call(args) {
        if (args.token === 'cloudflare:index/getZone:getZone') {
          const filter = args.inputs.filter as { name: string };
          return { id: ZONE_IDS[filter.name] ?? 'unknown-zone' };
        }
        if (args.token === 'auth0:index/getConnection:getConnection') {
          return { id: args.inputs.name === DATABASE_CONNECTION ? DATABASE_CONNECTION_ID : 'nope' };
        }
        return args.inputs;
      },
    },
    'panote-infra',
    'test',
    false,
  );
}

function settle<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply(resolve));
}

/** Runs the program for one stack's settings and waits for every registration. */
export async function run(
  settings: Settings,
  secrets: Auth0Secrets = {},
): Promise<{ resources: Map<string, Registered>; infra: Infra }> {
  registered = new Map();
  const { createInfra } = await import('./infra.js');
  const infra = createInfra(settings, secrets);
  await Promise.all(Object.values(infra.resources).map((resource) => settle(resource.urn)));
  return { resources: registered, infra };
}

/** A declared resource's inputs, after checking its type against names.ts. */
export function inputsOf(resources: Map<string, Registered>, key: ResourceKey) {
  const resource = resources.get(RESOURCES[key].name);
  if (!resource) throw new Error(`${key} was not declared`);
  expect(resource.type).toBe(RESOURCES[key].type);
  return resource.inputs;
}
