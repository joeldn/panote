import { RESOURCES, RULESET_PHASES, type ResourceKey } from './names.js';
import { readSettings, type Settings } from './settings.js';

/**
 * Builds the `pulumi import --file` document for resources that already exist
 * in an account (dev, made by hand), by reading their ids from the Cloudflare
 * API. Read-only: it only ever GETs.
 *
 * Names and types come from names.ts, the same table the program uses, so
 * every entry lands on the resource the program declares. Four resources
 * can't be imported at all (the provider has no import for them); they are
 * listed in `notImportable` and adopted by the first `pulumi up` instead
 * (infra/README.md).
 */

/** GET a Cloudflare API v4 path; `undefined` on 404. */
export type CloudflareGet = (path: string) => Promise<unknown>;

export interface ImportEntry {
  type: string;
  name: string;
  id: string;
}

export interface ImportPlan {
  resources: ImportEntry[];
  /** Resources the program declares that don't exist yet: `pulumi up` creates them. */
  missing: string[];
  notImportable: string[];
}

const NOT_IMPORTABLE: readonly ResourceKey[] = [
  'bucketCors',
  'managedDomain',
  'cdnDomain',
  'uploadNotification',
];

function results(where: string, body: unknown): Record<string, unknown>[] {
  const result = (body as { result?: unknown } | undefined)?.result;
  if (!Array.isArray(result)) throw new Error(`${where}: no result list in the response`);
  return result as Record<string, unknown>[];
}

function single(where: string, body: unknown, key: string): string | undefined {
  const matches = results(where, body);
  if (matches.length > 1) throw new Error(`${where}: ${matches.length} matches, expected one`);
  const value = matches[0]?.[key];
  if (matches.length === 1 && typeof value !== 'string') throw new Error(`${where}: no ${key}`);
  return value as string | undefined;
}

export async function buildImportPlan(settings: Settings, get: CloudflareGet): Promise<ImportPlan> {
  const { accountId, zone } = settings;
  const resources: ImportEntry[] = [];
  const missing: string[] = [];
  const add = (key: ResourceKey, id: string | undefined) => {
    const { type, name } = RESOURCES[key];
    if (id === undefined) missing.push(name);
    else resources.push({ type, name, id });
  };

  const zoneId = single(
    `zone ${zone}`,
    await get(`/zones?name=${encodeURIComponent(zone)}&account.id=${accountId}`),
    'id',
  );
  if (zoneId === undefined) throw new Error(`zone ${zone} not found in account ${accountId}`);

  const bucket = await get(`/accounts/${accountId}/r2/buckets/${settings.bucket}`);
  add('bucket', bucket === undefined ? undefined : `${accountId}/${settings.bucket}/default`);

  const queues = results('queues', await get(`/accounts/${accountId}/queues?per_page=100`));
  for (const [key, queueName] of [
    ['uploadsQueue', settings.uploadsQueue],
    ['deadLetterQueue', settings.deadLetterQueue],
  ] as const) {
    const queue = queues.find((q) => q.queue_name === queueName);
    add(key, typeof queue?.queue_id === 'string' ? `${accountId}/${queue.queue_id}` : undefined);
  }

  const phases: (keyof typeof RULESET_PHASES)[] = [
    'wafRuleset',
    'rateLimitRuleset',
    'cacheRuleset',
    'responseHeaderRuleset',
  ];
  if (settings.wwwRedirect) phases.push('redirectRuleset');
  for (const key of phases) {
    const body = await get(`/zones/${zoneId}/rulesets/phases/${RULESET_PHASES[key]}/entrypoint`);
    const id = (body as { result?: { id?: unknown } } | undefined)?.result?.id;
    add(key, typeof id === 'string' ? `zones/${zoneId}/${id}` : undefined);
  }

  // A zone setting and the URL normalization settings always exist.
  add('hsts', `${zoneId}/security_header`);
  add('urlNormalization', zoneId);

  const records: [ResourceKey, string][] = [['apexRecord', zone]];
  if (settings.wwwRedirect) records.push(['wwwRecord', `www.${zone}`]);
  for (const [key, name] of records) {
    const id = single(
      `AAAA ${name}`,
      await get(`/zones/${zoneId}/dns_records?type=AAAA&name.exact=${encodeURIComponent(name)}`),
      'id',
    );
    add(key, id === undefined ? undefined : `${zoneId}/${id}`);
  }

  return {
    resources,
    missing,
    notImportable: NOT_IMPORTABLE.map((key) => RESOURCES[key].name),
  };
}

/** A `CloudflareGet` over `fetch`, for the CLI. */
export function cloudflareGet(token: string, fetchImpl: typeof fetch = fetch): CloudflareGet {
  return async (path) => {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return undefined;
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const errors = (body as { errors?: { code?: unknown; message?: unknown }[] } | undefined)
        ?.errors;
      const detail = errors?.map((e) => `${String(e.code)} ${String(e.message)}`).join('; ');
      throw new Error(`GET ${path}: HTTP ${res.status}${detail ? ` (${detail})` : ''}`);
    }
    return body;
  };
}

/** The one key read from each provider's namespace. */
const PROVIDER_KEYS: Record<string, string | undefined> = { auth0: 'domain', github: 'owner' };

/**
 * Reads the flat `panote-infra:key: value` lines of a `Pulumi.<stack>.yaml`,
 * and the providers' `auth0:domain` and `github:owner` (as those keys), so the scripts need
 * neither a backend login nor a YAML dependency. A secret's line has no value
 * on it (the ciphertext is on the next line, under `secure:`), so secrets are
 * never read.
 */
export function parseStackConfig(yaml: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of yaml.split('\n')) {
    const match = /^\s+(panote-infra|auth0|github):([A-Za-z0-9]+):\s*(.*?)\s*$/.exec(line);
    const [, namespace, key, raw] = match ?? [];
    if (!namespace || !key || !raw) continue;
    const providerKey = PROVIDER_KEYS[namespace];
    if (providerKey !== undefined && key !== providerKey) continue;
    values.set(providerKey === undefined ? key : `${namespace}:${key}`, raw.replace(/^"|"$/g, ''));
  }
  return values;
}

/** A stack's settings from the text of its `Pulumi.<stack>.yaml`, as the program reads them. */
export function settingsFromStackFile(stack: 'dev' | 'production', yaml: string): Settings {
  const values = parseStackConfig(yaml);
  return readSettings(stack, {
    require: (key) => {
      const value = values.get(key);
      if (value === undefined) throw new Error(`Pulumi.${stack}.yaml: no panote-infra:${key}`);
      return value;
    },
    get: (key) => values.get(key),
    getBoolean: (key) => (values.has(key) ? values.get(key) === 'true' : undefined),
  });
}
