import { createRequire } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

import type * as Action from './link-accounts.cjs';

// The Action is CommonJS on purpose (it is pasted into Auth0 as it is), so load it that way.
const load = createRequire(import.meta.url);
const action = load('./link-accounts.cjs') as typeof Action;
const { choosePrimary, linkAccounts, managementClient, managementFromSecrets } = action;

type User = Parameters<typeof choosePrimary>[0];
type Management = NonNullable<Parameters<typeof linkAccounts>[2]['management']>;

const EMAIL = 'maya@example.com';

const user = (user_id: string, created_at: string, extra: Partial<User> = {}): User => {
  const [provider = '', id = ''] = user_id.split('|');
  return {
    user_id,
    email: EMAIL,
    email_verified: true,
    created_at,
    identities: [{ provider, user_id: id }],
    ...extra,
  };
};

const google = user('google-oauth2|111', '2026-01-01T00:00:00.000Z');
const emailUser = user('email|222', '2026-03-01T00:00:00.000Z');
const github = user('github|333', '2026-05-01T00:00:00.000Z', {
  identities: [{ provider: 'github', user_id: 333 }],
});

const without = (u: User, key: 'email' | 'email_verified' | 'created_at'): User => {
  const copy = { ...u };
  delete copy[key];
  return copy;
};

const fakeApi = () => ({ authentication: { setPrimaryUser: vi.fn() } });

const fakeManagement = (found: User[]): Management & { link: ReturnType<typeof vi.fn> } => ({
  usersByEmail: vi.fn(async () => found),
  link: vi.fn(async () => {}),
});

describe('choosePrimary', () => {
  it('picks the oldest verified user with the same email', () => {
    expect(choosePrimary(emailUser, [emailUser, github, google])).toBe('google-oauth2|111');
  });

  it('leaves the current user alone when it is the oldest', () => {
    expect(choosePrimary(google, [google, emailUser, github])).toBeNull();
    expect(choosePrimary(google, [])).toBeNull();
  });

  it('never picks a user whose email is unverified, different, or who is blocked', () => {
    const others = [
      { ...google, email_verified: false },
      { ...user('apple|9', '2025-01-01T00:00:00.000Z'), blocked: true },
      user('windowslive|8', '2025-02-01T00:00:00.000Z', { email: 'someone@else.example' }),
      without(user('facebook|7', '2025-03-01T00:00:00.000Z'), 'email_verified'),
    ];
    expect(choosePrimary(emailUser, others)).toBeNull();
  });

  it('never links from an unverified current email', () => {
    expect(choosePrimary({ ...github, email_verified: false }, [google])).toBeNull();
    expect(choosePrimary(without(github, 'email'), [google])).toBeNull();
  });

  it('matches the email case-insensitively', () => {
    expect(choosePrimary(emailUser, [{ ...google, email: 'Maya@Example.com ' }])).toBe(
      'google-oauth2|111',
    );
  });

  it('is deterministic: same created_at breaks on user_id, a missing created_at sorts last', () => {
    const a = user('linkedin|a', '2026-02-01T00:00:00.000Z');
    const b = user('github|b', '2026-02-01T00:00:00.000Z');
    expect(choosePrimary(a, [b])).toBe('github|b');
    expect(choosePrimary(b, [a])).toBeNull();
    const undated = without(user('apple|0', ''), 'created_at');
    expect(choosePrimary(undated, [github])).toBe('github|333');
    expect(choosePrimary(github, [undated])).toBeNull();
  });
});

describe('linkAccounts', () => {
  it('links the current user into the primary and continues the login as the primary', async () => {
    const api = fakeApi();
    const management = fakeManagement([google, github]);
    const log = vi.fn();
    const result = await linkAccounts({ user: github }, api, { management, log });
    expect(result).toBe('google-oauth2|111');
    expect(management.usersByEmail).toHaveBeenCalledWith(EMAIL);
    expect(management.link).toHaveBeenCalledWith('google-oauth2|111', {
      provider: 'github',
      user_id: '333',
    });
    expect(api.authentication.setPrimaryUser).toHaveBeenCalledWith('google-oauth2|111');
    expect(log.mock.calls.flat().join(' ')).not.toContain(EMAIL);
  });

  it('sets the primary user only after the link succeeded', async () => {
    const api = fakeApi();
    const management = fakeManagement([google]);
    management.link.mockRejectedValueOnce(new Error('management API POST failed: 400'));
    const log = vi.fn();
    await expect(linkAccounts({ user: emailUser }, api, { management, log })).resolves.toBeNull();
    expect(api.authentication.setPrimaryUser).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[link-accounts]',
      'linking failed, signing in unlinked:',
      'management API POST failed: 400',
    );
  });

  it('does nothing for an unverified email, without even looking anyone up', async () => {
    const api = fakeApi();
    const management = fakeManagement([google]);
    const event = { user: { ...emailUser, email_verified: false } };
    expect(await linkAccounts(event, api, { management, log: vi.fn() })).toBeNull();
    expect(management.usersByEmail).not.toHaveBeenCalled();
    expect(api.authentication.setPrimaryUser).not.toHaveBeenCalled();
  });

  it('does nothing on a refresh-token exchange', async () => {
    const management = fakeManagement([google]);
    const event = { user: emailUser, transaction: { protocol: 'oauth2-refresh-token' } };
    expect(await linkAccounts(event, fakeApi(), { management, log: vi.fn() })).toBeNull();
    expect(management.usersByEmail).not.toHaveBeenCalled();
  });

  it('does not link a user that already has linked identities', async () => {
    const management = fakeManagement([google]);
    const primaryOfItsOwn = {
      ...github,
      identities: [
        { provider: 'github', user_id: 333 },
        { provider: 'email', user_id: '444' },
      ],
    };
    const event = { user: primaryOfItsOwn };
    expect(await linkAccounts(event, fakeApi(), { management, log: vi.fn() })).toBeNull();
    expect(management.usersByEmail).not.toHaveBeenCalled();
  });

  it('leaves the oldest user as it is', async () => {
    const api = fakeApi();
    const management = fakeManagement([google, emailUser]);
    expect(await linkAccounts({ user: google }, api, { management, log: vi.fn() })).toBeNull();
    expect(management.link).not.toHaveBeenCalled();
    expect(api.authentication.setPrimaryUser).not.toHaveBeenCalled();
  });

  it('logs and signs in unlinked when the secrets are missing', async () => {
    const log = vi.fn();
    expect(
      await linkAccounts({ user: emailUser }, fakeApi(), { management: null, log }),
    ).toBeNull();
    expect(log.mock.calls[0]?.join(' ')).toMatch(/not configured/);
  });
});

describe('managementClient', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  const setup = () => {
    const store = new Map<string, { value: string; expires_at?: number }>();
    const cache = {
      get: (k: string) => store.get(k),
      set: (k: string, value: string, o?: { expires_at?: number }) => {
        store.set(k, { value, ...o });
      },
    };
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/oauth/token')
        ? ok({ access_token: 'tok', expires_in: 86400 })
        : url.includes('/users-by-email')
          ? ok([google])
          : ok({}),
    );
    const m = managementClient({
      domain: 'https://panote-dev.au.auth0.com/',
      clientId: 'cid',
      clientSecret: 'secret',
      fetch,
      cache,
      now: () => 1_000,
    });
    return { m, fetch, store };
  };

  it('gets an M2M token for the tenant Management API and reuses it from the cache', async () => {
    const { m, fetch, store } = setup();
    expect(await m.usersByEmail('maya+tours@example.com')).toEqual([google]);
    await m.usersByEmail(EMAIL);
    const tokenCalls = fetch.mock.calls.filter(([url]) => url.endsWith('/oauth/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.[0]).toBe('https://panote-dev.au.auth0.com/oauth/token');
    const init = (tokenCalls[0] as unknown[])[1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'cid',
      client_secret: 'secret',
      audience: 'https://panote-dev.au.auth0.com/api/v2/',
    });
    expect(store.get('mgmt-token')).toEqual({ value: 'tok', expires_at: 1_000 + 86340 * 1000 });
    expect(fetch).toHaveBeenCalledWith(
      'https://panote-dev.au.auth0.com/api/v2/users-by-email?email=maya%2Btours%40example.com',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer tok' }),
      }),
    );
  });

  it('links by POSTing the secondary identity to the primary', async () => {
    const { m, fetch } = setup();
    await m.link('google-oauth2|111', { provider: 'email', user_id: '222' });
    expect(fetch).toHaveBeenLastCalledWith(
      'https://panote-dev.au.auth0.com/api/v2/users/google-oauth2%7C111/identities',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ provider: 'email', user_id: '222' }),
      }),
    );
  });

  it('throws on a failed call', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    const m = managementClient({ domain: 'x.auth0.com', clientId: 'c', clientSecret: 's', fetch });
    await expect(m.usersByEmail(EMAIL)).rejects.toThrow('management token request failed: 403');
  });

  it('is built from the Action secrets, or not at all when one is missing', () => {
    const api = fakeApi();
    expect(managementFromSecrets({ user: google }, api)).toBeNull();
    expect(
      managementFromSecrets(
        { user: google, secrets: { AUTH0_DOMAIN: 'x', MGMT_CLIENT_ID: 'c' } },
        api,
      ),
    ).toBeNull();
    const full = { AUTH0_DOMAIN: 'x', MGMT_CLIENT_ID: 'c', MGMT_CLIENT_SECRET: 's' };
    expect(managementFromSecrets({ user: google, secrets: full }, api, vi.fn())).not.toBeNull();
  });
});

describe('onExecutePostLogin', () => {
  it('is exported for Auth0 and never throws, even unconfigured', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const api = fakeApi();
    await expect(action.onExecutePostLogin({ user: emailUser }, api)).resolves.toBeUndefined();
    expect(api.authentication.setPrimaryUser).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
