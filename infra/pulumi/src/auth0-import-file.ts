import { DATABASE_CONNECTION, POST_LOGIN_ACTIONS } from './auth0.js';
import type { ImportEntry } from './import-file.js';
import { RESOURCES, type ResourceKey } from './names.js';
import type { Auth0Settings } from './settings.js';

/**
 * Builds the `pulumi import --file` document for an Auth0 tenant that was set
 * up by hand (dev), by reading ids from the Management API. Read-only: after
 * the token request, it only ever GETs.
 *
 * Like import-file.ts, names and types come from names.ts. Each resource is
 * found by what the repo already says about it: the SPA by the client id the
 * apps are built with, the API by its audience, the linking client by the
 * name docs/deploy.md gave it, the Actions by theirs. The trigger bindings and
 * Attack Protection are settings every tenant has, so they are always
 * imported.
 */

/** GET a Management API v2 path (`/clients/...`); `undefined` on 404. */
export type Auth0Get = (path: string) => Promise<unknown>;

export interface Auth0ImportPlan {
  resources: ImportEntry[];
  /** Resources the program declares that don't exist yet: `pulumi up` creates them. */
  missing: string[];
}

/** The name docs/deploy.md ("Account linking", step 1) gave the linking client. */
export const LINKING_CLIENT_NAME = 'link-accounts action';

/**
 * `attackProtection` has no id in the API; the provider imports it under any
 * string, and this is the one the plan uses.
 */
export const ATTACK_PROTECTION_ID = 'attack-protection';

function list(where: string, body: unknown, key?: string): Record<string, unknown>[] {
  const value = key ? (body as Record<string, unknown> | undefined)?.[key] : body;
  if (!Array.isArray(value)) throw new Error(`${where}: no list in the response`);
  return value as Record<string, unknown>[];
}

function one(where: string, matches: Record<string, unknown>[], key: string): string | undefined {
  if (matches.length > 1) throw new Error(`${where}: ${matches.length} matches, expected one`);
  const value = matches[0]?.[key];
  if (matches.length === 1 && typeof value !== 'string') throw new Error(`${where}: no ${key}`);
  return value as string | undefined;
}

/** What an Auth0 client id looks like; anything else never reaches a URL. */
const CLIENT_ID = /^[A-Za-z0-9]+$/;

/** The Management API's largest page of clients. */
export const CLIENTS_PER_PAGE = 100;

/**
 * The SPA's client id, from the two apps' committed `.env.<stack>`
 * (`VITE_AUTH0_CLIENT_ID`). They must agree; a `YOUR_` placeholder means
 * there is no SPA yet.
 */
export function spaClientIdFromEnv(adminEnv: string, websiteEnv: string): string | undefined {
  const read = (env: string) => /^VITE_AUTH0_CLIENT_ID=(.*)$/m.exec(env)?.[1]?.trim();
  const admin = read(adminEnv);
  const website = read(websiteEnv);
  if (!admin || admin !== website) {
    throw new Error('apps/admin and apps/website name different VITE_AUTH0_CLIENT_IDs');
  }
  if (admin.startsWith('YOUR_')) return undefined;
  if (!CLIENT_ID.test(admin)) throw new Error(`VITE_AUTH0_CLIENT_ID "${admin}" is not a client id`);
  return admin;
}

export async function buildAuth0ImportPlan(
  zone: string,
  settings: Auth0Settings,
  spaClientId: string | undefined,
  get: Auth0Get,
): Promise<Auth0ImportPlan> {
  const resources: ImportEntry[] = [];
  const missing: string[] = [];
  const add = (key: ResourceKey, id: string | undefined) => {
    const { type, name } = RESOURCES[key];
    if (id === undefined) missing.push(name);
    else resources.push({ type, name, id });
  };

  const api = await get(`/resource-servers/${encodeURIComponent(`https://api.${zone}`)}`);
  const apiId = (api as { id?: unknown } | undefined)?.id;
  add('api', typeof apiId === 'string' ? apiId : undefined);

  let spa: string | undefined;
  if (spaClientId !== undefined) {
    const client = (await get(
      `/clients/${encodeURIComponent(spaClientId)}?fields=client_id,app_type`,
    )) as { app_type?: unknown } | undefined;
    if (client === undefined)
      throw new Error(`the apps' client ${spaClientId} is not in the tenant`);
    if (client.app_type !== 'spa') throw new Error(`client ${spaClientId} is not a SPA`);
    spa = spaClientId;
  }
  add('spaClient', spa);
  add('spaCredentials', spa);

  const google = one(
    'connection google-oauth2',
    list('connections', await get('/connections?strategy=google-oauth2&name=google-oauth2')),
    'id',
  );
  add('googleConnection', google);
  add('googleConnectionClients', google);
  const database = one(
    `connection ${DATABASE_CONNECTION}`,
    list('connections', await get(`/connections?name=${DATABASE_CONNECTION}`)),
    'id',
  );
  add('databaseConnectionClients', database);

  add('attackProtection', ATTACK_PROTECTION_ID);

  // Every page: a linking client missed on a later one would be planned as new,
  // and `up` would make a second one.
  const clients: Record<string, unknown>[] = [];
  for (let page = 0; ; page++) {
    const batch = list(
      'clients',
      await get(
        `/clients?app_type=non_interactive&fields=client_id,name&per_page=${CLIENTS_PER_PAGE}&page=${page}`,
      ),
    );
    clients.push(...batch);
    if (batch.length < CLIENTS_PER_PAGE) break;
  }
  const linking = one(
    `client "${LINKING_CLIENT_NAME}"`,
    clients.filter((c) => c.name === LINKING_CLIENT_NAME),
    'client_id',
  );
  add('linkingClient', linking);
  add('linkingCredentials', linking);
  const audience = encodeURIComponent(`https://${settings.domain}/api/v2/`);
  add(
    'linkingGrant',
    linking === undefined
      ? undefined
      : one(
          'linking grant',
          list(
            'client-grants',
            await get(`/client-grants?client_id=${linking}&audience=${audience}`),
          ),
          'id',
        ),
  );

  for (const { key, name } of POST_LOGIN_ACTIONS) {
    const body = await get(`/actions/actions?actionName=${encodeURIComponent(name)}`);
    const matches = list(`action "${name}"`, body, 'actions').filter((a) => a.name === name);
    add(key, one(`action "${name}"`, matches, 'id'));
  }
  // The post-login bindings always exist, if only as an empty list.
  add('postLoginActions', 'post-login');

  return { resources, missing };
}

/**
 * An `Auth0Get` over `fetch`, for the CLI: one client-credentials token for
 * the Management API, then GETs.
 */
export async function auth0Get(
  domain: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Auth0Get> {
  const base = `https://${domain}`;
  const res = await fetchImpl(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: `${base}/api/v2/`,
    }),
  });
  const token = (
    (await res.json().catch(() => undefined)) as { access_token?: unknown } | undefined
  )?.access_token;
  if (!res.ok || typeof token !== 'string') {
    throw new Error(`token request to ${domain}: HTTP ${res.status}`);
  }
  return async (path) => {
    const got = await fetchImpl(`${base}/api/v2${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (got.status === 404) return undefined;
    const body: unknown = await got.json().catch(() => undefined);
    if (!got.ok) {
      const message = (body as { message?: unknown } | undefined)?.message;
      throw new Error(`GET ${path}: HTTP ${got.status}${message ? ` (${String(message)})` : ''}`);
    }
    return body;
  };
}
