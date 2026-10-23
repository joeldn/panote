import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { managementSecret, normaliseBanList, requireClientSecret } from './auth0.js';
import { RESOURCES, type ResourceKey } from './names.js';
import type { Settings } from './settings.js';
import {
  DATABASE_CONNECTION_ID,
  inputsOf,
  installMocks,
  run,
  stackSettings,
  type Registered,
} from './test-support.js';

beforeAll(installMocks);

const REPO = new URL('../../../', import.meta.url);
const repoFile = (path: string) => readFileSync(new URL(path, REPO), 'utf8');

const AUTH0_KEYS = Object.keys(RESOURCES).filter((key) =>
  RESOURCES[key as ResourceKey].type.startsWith('auth0:'),
) as ResourceKey[];

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/**
 * The stacks as they will be once each names its tenant: dev at its import,
 * with the committed file's other Auth0 keys, production once it exists.
 */
const DEV_WITH_TENANT: Settings = {
  ...stackSettings('dev'),
  auth0: { domain: 'panote-dev.au.auth0.com', localDevCallbacks: true },
};

const PRODUCTION_WITH_TENANT: Settings = {
  ...stackSettings('production'),
  auth0: {
    domain: 'panote.us.auth0.com',
    googleClientId: '1234-abc.apps.googleusercontent.com',
    localDevCallbacks: false,
  },
};

/** How the mocks see a secret value: wrapped under Pulumi's secret signature. */
const SECRET_SIG = '4dabf18193072939515e22adb298388d';
const isSecret = (value: unknown): value is { value: unknown } =>
  typeof value === 'object' && value !== null && SECRET_SIG in value;
const reveal = (value: unknown) => (isSecret(value) ? value.value : value);

describe('the dev tenant', () => {
  const settings = DEV_WITH_TENANT;
  let resources: Map<string, Registered>;
  beforeAll(async () => {
    ({ resources } = await run(settings));
  });

  it('declares every Auth0 resource', () => {
    for (const key of AUTH0_KEYS) inputsOf(resources, key);
  });

  it('issues tokens for the audience and issuer the APIs and apps are configured with', async () => {
    const { infra } = await run(settings);
    expect(infra.auth0?.issuer).toBe('https://panote-dev.au.auth0.com/');
    expect(inputsOf(resources, 'api')).toMatchObject({
      identifier: 'https://api.panote.dev',
      signingAlg: 'RS256',
      allowOfflineAccess: true,
    });
    for (const service of ['admin-api', 'public-api', 'upload-api']) {
      const wrangler = repoFile(`services/${service}/wrangler.jsonc`);
      expect(wrangler).toContain('"OAUTH_ISSUER": "https://panote-dev.au.auth0.com/"');
      expect(wrangler).toContain('"OAUTH_AUDIENCE": "https://api.panote.dev"');
    }
    for (const app of ['admin', 'website']) {
      const env = repoFile(`apps/${app}/.env.dev`);
      expect(env).toContain('VITE_AUTH0_DOMAIN=panote-dev.au.auth0.com\n');
      expect(env).toContain('VITE_AUTH0_AUDIENCE=https://api.panote.dev\n');
    }
  });

  it('gives the SPA the callbacks and origins in docs/deploy.md, local dev included', () => {
    expect(inputsOf(resources, 'spaClient')).toMatchObject({
      appType: 'spa',
      oidcConformant: true,
      grantTypes: ['authorization_code', 'refresh_token'],
      callbacks: ['https://panote.dev/app/callback', 'http://localhost:5173/app/callback'],
      allowedLogoutUrls: [
        'https://panote.dev/',
        'https://panote.dev/app/',
        'http://localhost:5173/app/',
        'http://localhost:5174/',
      ],
      webOrigins: ['https://panote.dev', 'http://localhost:5173'],
    });
  });

  it('rotates refresh tokens and gives the SPA no secret', () => {
    expect(inputsOf(resources, 'spaClient').refreshToken).toMatchObject({
      rotationType: 'rotating',
      expirationType: 'expiring',
      infiniteTokenLifetime: false,
      infiniteIdleTokenLifetime: false,
    });
    expect(inputsOf(resources, 'spaCredentials')).toEqual({
      clientId: `${RESOURCES.spaClient.name}-client-id`,
      authenticationMethod: 'none',
    });
  });

  it("signs in with Google for the SPA only, on Auth0's developer keys while no client is set", () => {
    const google = inputsOf(resources, 'googleConnection');
    expect(google).toMatchObject({ name: 'google-oauth2', strategy: 'google-oauth2' });
    expect(google.options).toEqual({ scopes: ['email', 'profile'] });
    expect(inputsOf(resources, 'googleConnectionClients')).toEqual({
      connectionId: `${RESOURCES.googleConnection.name}-id`,
      enabledClients: [`${RESOURCES.spaClient.name}-client-id`],
    });
  });

  it('turns the password database off for every application', () => {
    expect(inputsOf(resources, 'databaseConnectionClients')).toEqual({
      connectionId: DATABASE_CONNECTION_ID,
      enabledClients: [],
    });
  });

  it('turns on brute-force, suspicious-IP and breached-password protection', () => {
    const inputs = inputsOf(resources, 'attackProtection');
    expect(inputs.bruteForceProtection).toMatchObject({
      enabled: true,
      shields: ['block', 'user_notification'],
    });
    expect(inputs.suspiciousIpThrottling).toMatchObject({
      enabled: true,
      shields: ['admin_notification', 'block'],
      preLogin: { maxAttempts: 100, rate: 864000 },
      preUserRegistration: { maxAttempts: 50, rate: 1200 },
    });
    expect(inputs.breachedPasswordDetection).toMatchObject({ enabled: true, method: 'standard' });
  });

  it('lets the linking client read and update users on the Management API, nothing else', () => {
    expect(inputsOf(resources, 'linkingClient')).toMatchObject({
      appType: 'non_interactive',
      grantTypes: ['client_credentials'],
    });
    expect(inputsOf(resources, 'linkingCredentials').authenticationMethod).toBe(
      'client_secret_post',
    );
    const grant = inputsOf(resources, 'linkingGrant');
    expect(grant).toEqual({
      clientId: `${RESOURCES.linkingClient.name}-client-id`,
      audience: 'https://panote-dev.au.auth0.com/api/v2/',
      scopes: ['read:users', 'update:users'],
    });
    // No client is ever granted Panote's own API.
    for (const resource of resources.values()) {
      if (resource.type === RESOURCES.linkingGrant.type) {
        expect(resource.inputs.audience).not.toBe('https://api.panote.dev');
      }
    }
  });

  it('deploys each Action from packages/auth0-actions as it is in the repo', () => {
    for (const [key, file, name] of [
      ['banListAction', 'ban-list.cjs', 'Block banned emails'],
      ['linkAccountsAction', 'link-accounts.cjs', 'Link accounts by verified email'],
    ] as const) {
      expect(inputsOf(resources, key)).toMatchObject({
        name,
        runtime: 'node22',
        supportedTriggers: { id: 'post-login', version: 'v3' },
        deploy: true,
        code: repoFile(`packages/auth0-actions/src/${file}`),
      });
    }
  });

  it("gives link-accounts the tenant and the linking client's own id and secret", () => {
    const secrets = inputsOf(resources, 'linkAccountsAction').secrets;
    expect(isSecret(secrets)).toBe(true);
    expect(reveal(secrets)).toEqual([
      { name: 'AUTH0_DOMAIN', value: 'panote-dev.au.auth0.com' },
      { name: 'MGMT_CLIENT_ID', value: `${RESOURCES.linkingClient.name}-client-id` },
      { name: 'MGMT_CLIENT_SECRET', value: `${RESOURCES.linkingCredentials.name}-secret` },
    ]);
  });

  it('leaves the ban list out while the stack has none', () => {
    expect(reveal(inputsOf(resources, 'banListAction').secrets)).toEqual([]);
  });

  it('runs the ban list first, then linking, and nothing else after login', () => {
    expect(inputsOf(resources, 'postLoginActions')).toEqual({
      trigger: 'post-login',
      actions: [
        { id: `${RESOURCES.banListAction.name}-id`, displayName: 'Block banned emails' },
        {
          id: `${RESOURCES.linkAccountsAction.name}-id`,
          displayName: 'Link accounts by verified email',
        },
      ],
    });
  });
});

describe('the stack config secrets', () => {
  it('pass the Google client secret and the normalised ban list through', async () => {
    const { resources } = await run(
      {
        ...DEV_WITH_TENANT,
        auth0: { ...DEV_WITH_TENANT.auth0!, googleClientId: '1234-abc.apps.googleusercontent.com' },
      },
      {
        googleClientSecret: 'google-secret',
        bannedEmailSha256: ` ${HASH_A.toUpperCase()}\n${HASH_B}, ${HASH_A}`,
      },
    );
    expect(inputsOf(resources, 'googleConnection').options).toEqual({
      scopes: ['email', 'profile'],
      clientId: '1234-abc.apps.googleusercontent.com',
      clientSecret: 'google-secret',
    });
    expect(reveal(inputsOf(resources, 'banListAction').secrets)).toEqual([
      { name: 'BANNED_EMAIL_SHA256', value: `${HASH_A},${HASH_B}` },
    ]);
  });
});

describe('a stack without a tenant', () => {
  it('declares nothing in Auth0', async () => {
    const { auth0: _, ...withoutTenant } = DEV_WITH_TENANT;
    const { resources, infra } = await run(withoutTenant);
    for (const key of AUTH0_KEYS) expect(resources.has(RESOURCES[key].name)).toBe(false);
    expect(infra.auth0).toBeUndefined();
  });

  it('is the committed dev file until the import names its tenant, which is dev-only', () => {
    const named = stackSettings('dev').auth0;
    if (named !== undefined) expect(named).toEqual(DEV_WITH_TENANT.auth0);
  });
});

describe('the production tenant', () => {
  it('serves panote.io only, with no localhost anywhere', async () => {
    const { resources, infra } = await run(PRODUCTION_WITH_TENANT);
    expect(infra.auth0?.audience).toBe('https://api.panote.io');
    expect(inputsOf(resources, 'spaClient')).toMatchObject({
      callbacks: ['https://panote.io/app/callback'],
      allowedLogoutUrls: ['https://panote.io/', 'https://panote.io/app/'],
      webOrigins: ['https://panote.io'],
    });
    expect(inputsOf(resources, 'linkingGrant').audience).toBe(
      'https://panote.us.auth0.com/api/v2/',
    );
    const all = JSON.stringify(AUTH0_KEYS.map((key) => inputsOf(resources, key)));
    expect(all).not.toContain('localhost');
    expect(all).not.toContain('panote.dev');
    for (const app of ['admin', 'website']) {
      expect(repoFile(`apps/${app}/.env.production`)).toContain(
        'VITE_AUTH0_AUDIENCE=https://api.panote.io\n',
      );
    }
    expect(repoFile('services/admin-api/wrangler.jsonc')).toContain(
      '"OAUTH_AUDIENCE": "https://api.panote.io"',
    );
  });
});

describe('normaliseBanList', () => {
  it('lower-cases, dedupes and joins the hashes with commas', () => {
    expect(normaliseBanList(`${HASH_B}\n\n${HASH_A.toUpperCase()} ,${HASH_B}`)).toBe(
      `${HASH_B},${HASH_A}`,
    );
    expect(normaliseBanList('  ')).toBe('');
  });

  it('refuses anything that is not a hash, without echoing it', () => {
    expect(() => normaliseBanList(`${HASH_A},someone@example.com`)).toThrow(
      /^bannedEmailSha256: 1 entry is not a SHA-256 hash/,
    );
    expect(() => normaliseBanList('someone@example.com')).not.toThrow(/someone/);
    expect(() => normaliseBanList(`${HASH_A.slice(1)} x`)).toThrow(/2 entries are not/);
  });
});

describe('requireClientSecret', () => {
  it('passes a secret through and stops on an empty one', () => {
    expect(requireClientSecret('s3cret')).toBe('s3cret');
    expect(() => requireClientSecret('')).toThrow(/read:client_keys/);
    expect(() => requireClientSecret(undefined)).toThrow(/read:client_keys/);
  });
});

describe('managementSecret', () => {
  it('takes the state as it is at preview, so the preview client needs no read:client_keys', () => {
    expect(managementSecret('', true)).toBe('');
    expect(managementSecret(undefined, true)).toBe('');
    expect(managementSecret('s3cret', true)).toBe('s3cret');
  });

  it('still stops an up on an empty secret', () => {
    expect(managementSecret('s3cret', false)).toBe('s3cret');
    expect(() => managementSecret('', false)).toThrow(/read:client_keys/);
  });
});
