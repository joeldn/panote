import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  auth0Get,
  buildAuth0ImportPlan,
  spaClientIdFromEnv,
  type Auth0Get,
} from './auth0-import-file.js';
import { RESOURCES, type ResourceKey } from './names.js';
import { stackSettings } from './test-support.js';

const SPA = 'DEXWa49LnwVmX8flff1kcxHpj8G0d9d2';
const CLIENTS_PAGE = (page: number) =>
  `/clients?app_type=non_interactive&fields=client_id,name&per_page=100&page=${page}`;
const MGMT = encodeURIComponent('https://panote-dev.au.auth0.com/api/v2/');

/** A read-only API double: path → response body, anything else 404s. */
function fakeApi(responses: Record<string, unknown>): Auth0Get & { paths: string[] } {
  const paths: string[] = [];
  const get = async (path: string) => {
    paths.push(path);
    return responses[path];
  };
  return Object.assign(get, { paths });
}

const DEV_API = {
  [`/resource-servers/${encodeURIComponent('https://api.panote.dev')}`]: { id: 'rs_api' },
  [`/clients/${SPA}?fields=client_id,app_type`]: { client_id: SPA, app_type: 'spa' },
  '/connections?strategy=google-oauth2&name=google-oauth2': [{ id: 'con_google' }],
  '/connections?name=Username-Password-Authentication': [{ id: 'con_db' }],
  [CLIENTS_PAGE(0)]: [
    { client_id: 'm2m_pulumi', name: 'pulumi' },
    { client_id: 'm2m_link', name: 'link-accounts action' },
  ],
  [`/client-grants?client_id=m2m_link&audience=${MGMT}`]: [{ id: 'cgr_link' }],
  [`/actions/actions?actionName=${encodeURIComponent('Block banned emails')}`]: {
    actions: [{ id: 'act_ban', name: 'Block banned emails' }],
  },
  [`/actions/actions?actionName=${encodeURIComponent('Link accounts by verified email')}`]: {
    actions: [
      { id: 'act_link', name: 'Link accounts by verified email' },
      { id: 'act_other', name: 'Link accounts by verified email (old copy)' },
    ],
  },
};

const entry = (key: ResourceKey, id: string) => ({
  type: RESOURCES[key].type,
  name: RESOURCES[key].name,
  id,
});

const dev = stackSettings('dev');
/** Dev's tenant, as the import names it in the stack file (infra/README.md, step 13). */
const devAuth0 = { domain: 'panote-dev.au.auth0.com', localDevCallbacks: true };

describe('buildAuth0ImportPlan', () => {
  it('finds every resource the dev tenant has, with the id its import needs', async () => {
    const api = fakeApi(DEV_API);
    const plan = await buildAuth0ImportPlan(dev.zone, devAuth0, SPA, api);
    expect(plan.resources).toEqual([
      entry('api', 'rs_api'),
      entry('spaClient', SPA),
      entry('spaCredentials', SPA),
      entry('googleConnection', 'con_google'),
      entry('googleConnectionClients', 'con_google'),
      entry('databaseConnectionClients', 'con_db'),
      entry('attackProtection', 'attack-protection'),
      entry('linkingClient', 'm2m_link'),
      entry('linkingCredentials', 'm2m_link'),
      entry('linkingGrant', 'cgr_link'),
      entry('banListAction', 'act_ban'),
      entry('linkAccountsAction', 'act_link'),
      entry('postLoginActions', 'post-login'),
    ]);
    expect(plan.missing).toEqual([]);
  });

  it('finds the linking client on a later page', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      client_id: `c${i}`,
      name: `m2m ${i}`,
    }));
    const api = fakeApi({
      ...DEV_API,
      [CLIENTS_PAGE(0)]: fullPage,
      [CLIENTS_PAGE(1)]: [{ client_id: 'm2m_link', name: 'link-accounts action' }],
    });
    const plan = await buildAuth0ImportPlan(dev.zone, devAuth0, SPA, api);
    expect(plan.resources).toContainEqual(entry('linkingClient', 'm2m_link'));
    expect(plan.missing).toEqual([]);
    expect(api.paths.filter((path) => path.startsWith('/clients?'))).toEqual([
      CLIENTS_PAGE(0),
      CLIENTS_PAGE(1),
    ]);
  });

  it('encodes the SPA client id in the path', async () => {
    const api = fakeApi({ ...DEV_API });
    await buildAuth0ImportPlan(dev.zone, devAuth0, SPA, api).catch(() => undefined);
    expect(api.paths).toContain(`/clients/${encodeURIComponent(SPA)}?fields=client_id,app_type`);
    const odd = fakeApi({});
    await expect(buildAuth0ImportPlan(dev.zone, devAuth0, 'a/b?c', odd)).rejects.toThrow();
    expect(odd.paths).toContain('/clients/a%2Fb%3Fc?fields=client_id,app_type');
  });

  it('on a fresh tenant, imports only what every tenant has', async () => {
    const plan = await buildAuth0ImportPlan(
      dev.zone,
      devAuth0,
      undefined,
      fakeApi({
        '/connections?strategy=google-oauth2&name=google-oauth2': [],
        '/connections?name=Username-Password-Authentication': [{ id: 'con_db' }],
        [CLIENTS_PAGE(0)]: [],
        [`/actions/actions?actionName=${encodeURIComponent('Block banned emails')}`]: {
          actions: [],
        },
        [`/actions/actions?actionName=${encodeURIComponent('Link accounts by verified email')}`]: {
          actions: [],
        },
      }),
    );
    expect(plan.resources.map((e) => e.name)).toEqual([
      'auth0-database-clients',
      'auth0-attack-protection',
      'auth0-post-login-actions',
    ]);
    expect(plan.missing).toEqual([
      'auth0-api',
      'auth0-spa',
      'auth0-spa-credentials',
      'auth0-google',
      'auth0-google-clients',
      'auth0-link-accounts-client',
      'auth0-link-accounts-credentials',
      'auth0-link-accounts-grant',
      'auth0-ban-list-action',
      'auth0-link-accounts-action',
    ]);
  });

  it.each([
    [
      "the apps' client is missing",
      { [`/clients/${SPA}?fields=client_id,app_type`]: undefined },
      /not in the tenant/,
    ],
    [
      "the apps' client is not a SPA",
      { [`/clients/${SPA}?fields=client_id,app_type`]: { app_type: 'regular_web' } },
      /not a SPA/,
    ],
    [
      'two clients share the linking name',
      {
        [CLIENTS_PAGE(0)]: [
          { client_id: 'a', name: 'link-accounts action' },
          { client_id: 'b', name: 'link-accounts action' },
        ],
      },
      /2 matches/,
    ],
    [
      'a response is not a list',
      { '/connections?name=Username-Password-Authentication': {} },
      /no list/,
    ],
    [
      'an action has no id',
      {
        [`/actions/actions?actionName=${encodeURIComponent('Block banned emails')}`]: {
          actions: [{ name: 'Block banned emails' }],
        },
      },
      /no id/,
    ],
  ])('stops when %s', async (_, override, error) => {
    await expect(
      buildAuth0ImportPlan(dev.zone, devAuth0, SPA, fakeApi({ ...DEV_API, ...override })),
    ).rejects.toThrow(error);
  });
});

describe('spaClientIdFromEnv', () => {
  const repoFile = (path: string) =>
    readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

  it("reads the client id both apps' committed env files name", () => {
    expect(
      spaClientIdFromEnv(repoFile('apps/admin/.env.dev'), repoFile('apps/website/.env.dev')),
    ).toBe(SPA);
  });

  it('treats the production placeholder as no SPA yet', () => {
    expect(
      spaClientIdFromEnv(
        repoFile('apps/admin/.env.production'),
        repoFile('apps/website/.env.production'),
      ),
    ).toBeUndefined();
  });

  it('refuses apps that disagree', () => {
    expect(() =>
      spaClientIdFromEnv('VITE_AUTH0_CLIENT_ID=a\n', 'VITE_AUTH0_CLIENT_ID=b\n'),
    ).toThrow(/different/);
    expect(() => spaClientIdFromEnv('', '')).toThrow(/different/);
  });

  it('refuses a value that is not a client id', () => {
    for (const value of ['abc/def', 'abc?x=1', '../clients', 'a b']) {
      const env = `VITE_AUTH0_CLIENT_ID=${value}\n`;
      expect(() => spaClientIdFromEnv(env, env)).toThrow(/not a client id/);
    }
  });
});

describe('auth0Get', () => {
  const response = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('takes a Management API token, then GETs with it', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/oauth/token') ? response(200, { access_token: 'tok' }) : response(200, []),
    );
    const get = await auth0Get('t.auth0.com', 'id', 'secret', fetchImpl as unknown as typeof fetch);
    await expect(get('/clients')).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://t.auth0.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'id',
        client_secret: 'secret',
        audience: 'https://t.auth0.com/api/v2/',
      }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://t.auth0.com/api/v2/clients', {
      headers: { Authorization: 'Bearer tok' },
    });
  });

  it('stops when the token request fails', async () => {
    await expect(
      auth0Get('t.auth0.com', 'id', 'bad', (async () =>
        response(401, { error: 'access_denied' })) as unknown as typeof fetch),
    ).rejects.toThrow('token request to t.auth0.com: HTTP 401');
  });

  it('maps 404 to undefined and throws with the message on any other failure', async () => {
    const statuses = [404, 403];
    const get = await auth0Get('t.auth0.com', 'id', 'secret', (async (url: string) =>
      url.endsWith('/oauth/token')
        ? response(200, { access_token: 'tok' })
        : response(statuses.shift() ?? 500, {
            message: 'Insufficient scope, expected any of: read:clients',
          })) as unknown as typeof fetch);
    await expect(get('/x')).resolves.toBeUndefined();
    await expect(get('/clients')).rejects.toThrow(
      'GET /clients: HTTP 403 (Insufficient scope, expected any of: read:clients)',
    );
  });
});
