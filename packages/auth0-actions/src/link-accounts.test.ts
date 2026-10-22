import { createRequire } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

import type * as Action from './link-accounts.cjs';

// The Action is CommonJS on purpose (it is pasted into Auth0 as it is), so load it that way.
const load = createRequire(import.meta.url);
const action = load('./link-accounts.cjs') as typeof Action;
const {
  ManagementError,
  TRUSTED_PROVIDERS,
  choosePrimary,
  linkAccounts,
  managementClient,
  managementFromSecrets,
} = action;

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

const without = (u: User, key: 'email' | 'email_verified' | 'created_at'): User => {
  const copy = { ...u };
  delete copy[key];
  return copy;
};

const google = user('google-oauth2|111', '2026-01-01T00:00:00.000Z');
const emailUser = user('email|222', '2026-03-01T00:00:00.000Z');
const github = user('github|333', '2026-05-01T00:00:00.000Z', {
  identities: [{ provider: 'github', user_id: 333 }],
});

const fakeApi = () => ({ authentication: { setPrimaryUser: vi.fn() } });

const fakeManagement = (
  found: User[],
): Management & { link: ReturnType<typeof vi.fn>; usersByEmail: ReturnType<typeof vi.fn> } => ({
  usersByEmail: vi.fn(async () => found),
  link: vi.fn(async () => {}),
});

describe('TRUSTED_PROVIDERS', () => {
  it('trusts passwordless email, Google, Apple and GitHub only', () => {
    expect([...TRUSTED_PROVIDERS].sort()).toEqual(['apple', 'email', 'github', 'google-oauth2']);
  });
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
      user('google-oauth2|8', '2025-02-01T00:00:00.000Z', { email: 'someone@else.example' }),
      without(user('github|7', '2025-03-01T00:00:00.000Z'), 'email_verified'),
    ];
    expect(choosePrimary(emailUser, others)).toBeNull();
  });

  it('never links from an unverified current email', () => {
    expect(choosePrimary({ ...github, email_verified: false }, [google])).toBeNull();
    expect(choosePrimary(without(github, 'email'), [google])).toBeNull();
  });

  it.each(['windowslive', 'linkedin', 'facebook', 'auth0'])(
    'never joins a %s sign-in, as the current user or as the primary',
    (provider) => {
      const untrusted = user(`${provider}|5`, '2025-01-01T00:00:00.000Z');
      const newer = user(`${provider}|6`, '2027-01-01T00:00:00.000Z');
      expect(choosePrimary(emailUser, [untrusted])).toBeNull();
      expect(choosePrimary(newer, [google])).toBeNull();
    },
  );

  it('counts a primary through a linked trusted identity carrying the verified email', () => {
    // An old Microsoft user that later linked a Google identity with the same address.
    const linked = user('windowslive|1', '2025-01-01T00:00:00.000Z', {
      identities: [
        { provider: 'windowslive', user_id: '1' },
        {
          provider: 'google-oauth2',
          user_id: '9',
          profileData: { email: EMAIL, email_verified: true },
        },
      ],
    });
    expect(choosePrimary(emailUser, [linked])).toBe('windowslive|1');
    const unverifiedLink = {
      ...linked,
      identities: [
        { provider: 'windowslive', user_id: '1' },
        { provider: 'google-oauth2', user_id: '9', profileData: { email: EMAIL } },
      ],
    };
    expect(choosePrimary(emailUser, [unverifiedLink])).toBeNull();
  });

  it('matches the email case-insensitively', () => {
    expect(choosePrimary(emailUser, [{ ...google, email: 'Maya@Example.com ' }])).toBe(
      'google-oauth2|111',
    );
  });

  it('is deterministic: same created_at breaks on user_id, a missing created_at sorts last', () => {
    const a = user('apple|a', '2026-02-01T00:00:00.000Z');
    const b = user('github|b', '2026-02-01T00:00:00.000Z');
    expect(choosePrimary(b, [a])).toBe('apple|a');
    expect(choosePrimary(a, [b])).toBeNull();
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
    expect(management.usersByEmail).toHaveBeenCalledWith(EMAIL, expect.any(AbortSignal));
    expect(management.link).toHaveBeenCalledWith(
      'google-oauth2|111',
      { provider: 'github', user_id: '333' },
      expect.any(AbortSignal),
    );
    expect(api.authentication.setPrimaryUser).toHaveBeenCalledWith('google-oauth2|111');
    expect(log.mock.calls.flat().join(' ')).not.toContain(EMAIL);
  });

  it('sets the primary user only after the link succeeded', async () => {
    const api = fakeApi();
    const management = fakeManagement([google]);
    management.link.mockRejectedValueOnce(new Error('network down'));
    const log = vi.fn();
    await expect(linkAccounts({ user: emailUser }, api, { management, log })).resolves.toBeNull();
    expect(api.authentication.setPrimaryUser).not.toHaveBeenCalled();
    expect(management.link).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[link-accounts]',
      'linking failed, signing in unlinked:',
      'network down',
    );
  });

  it.each([400, 409])(
    'on a %i from the link call, looks again once and links into the fresh primary',
    async (status) => {
      const api = fakeApi();
      // A concurrent first login: the first lookup saw a primary that was itself just linked away.
      const gone = user('github|1', '2025-12-01T00:00:00.000Z');
      const management = fakeManagement([]);
      management.usersByEmail.mockResolvedValueOnce([gone, google]).mockResolvedValueOnce([google]);
      management.link.mockRejectedValueOnce(new ManagementError('stale', status));
      const result = await linkAccounts({ user: emailUser }, api, { management, log: vi.fn() });
      expect(result).toBe('google-oauth2|111');
      expect(management.usersByEmail).toHaveBeenCalledTimes(2);
      expect(management.link).toHaveBeenNthCalledWith(
        1,
        'github|1',
        expect.anything(),
        expect.anything(),
      );
      expect(management.link).toHaveBeenNthCalledWith(
        2,
        'google-oauth2|111',
        expect.anything(),
        expect.anything(),
      );
      expect(api.authentication.setPrimaryUser).toHaveBeenCalledWith('google-oauth2|111');
    },
  );

  it('retries a stale link only once', async () => {
    const api = fakeApi();
    const management = fakeManagement([google]);
    management.link.mockRejectedValue(new ManagementError('conflict', 409));
    expect(await linkAccounts({ user: emailUser }, api, { management, log: vi.fn() })).toBeNull();
    expect(management.link).toHaveBeenCalledTimes(2);
    expect(api.authentication.setPrimaryUser).not.toHaveBeenCalled();
  });

  it('does not retry other link failures', async () => {
    const management = fakeManagement([google]);
    management.link.mockRejectedValue(new ManagementError('forbidden', 403));
    await linkAccounts({ user: emailUser }, fakeApi(), { management, log: vi.fn() });
    expect(management.link).toHaveBeenCalledTimes(1);
    expect(management.usersByEmail).toHaveBeenCalledTimes(1);
  });

  it('has one 10 s deadline for the whole run', () => {
    expect(action.DEADLINE_MS).toBe(10_000);
  });

  it('gives up at the overall deadline, even when each call is within its own timeout', async () => {
    // A Management API that answers every call just under the 5 s per-call timeout, scaled
    // down: per-call timeout 1000 ms, each call 60 ms, deadline 100 ms. Lookup, a stale link,
    // lookup and link again would take 240 ms; the deadline stops it at 100.
    const slow = <T>(value: () => T) =>
      vi.fn(
        (..._args: unknown[]) =>
          new Promise<T>((resolve, reject) =>
            setTimeout(() => {
              try {
                resolve(value());
              } catch (e) {
                reject(e as Error);
              }
            }, 60),
          ),
      );
    const management = {
      usersByEmail: slow(() => [google]),
      link: slow((): void => {
        throw new ManagementError('stale', 409);
      }),
    };
    const api = fakeApi();
    const log = vi.fn();
    const started = Date.now();
    const result = await linkAccounts({ user: emailUser }, api, {
      management,
      log,
      deadlineMs: 100,
    });
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
    expect(api.authentication.setPrimaryUser).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[link-accounts]',
      'linking timed out after 100 ms, signing in unlinked',
    );
  });

  it('ends at the deadline even when a step ignores the abort signal', async () => {
    const management = fakeManagement([]);
    management.usersByEmail.mockImplementation(() => new Promise(() => {}));
    const log = vi.fn();
    await expect(
      linkAccounts({ user: emailUser }, fakeApi(), { management, log, deadlineMs: 30 }),
    ).resolves.toBeNull();
    expect(log.mock.calls[0]?.[1]).toMatch(/timed out/);
  }, 1000);

  it('skips the stale retry once the deadline has passed', async () => {
    const management = fakeManagement([google]);
    management.link.mockImplementation(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new ManagementError('conflict', 409)), 40),
        ),
    );
    await linkAccounts({ user: emailUser }, fakeApi(), {
      management,
      log: vi.fn(),
      deadlineMs: 20,
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(management.usersByEmail).toHaveBeenCalledTimes(1);
  });

  it('passes the deadline to every Management API call', async () => {
    const management = fakeManagement([google]);
    await linkAccounts({ user: emailUser }, fakeApi(), { management, log: vi.fn() });
    const signal = management.usersByEmail.mock.calls[0]?.[1] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(management.link.mock.calls[0]?.[2]).toBe(signal);
  });

  it('aborts in-flight Management API calls when the deadline passes', async () => {
    let seen: AbortSignal | undefined;
    const fetch = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          seen = init?.signal;
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const management = managementClient({
      domain: 'x.auth0.com',
      clientId: 'c',
      clientSecret: 's',
      fetch,
      timeoutMs: 5000,
    });
    const log = vi.fn();
    await linkAccounts({ user: emailUser }, fakeApi(), { management, log, deadlineMs: 30 });
    expect(seen?.aborted).toBe(true);
    expect(log.mock.calls[0]?.[1]).toMatch(/timed out/);
  });

  it('does nothing for an unverified email, without even looking anyone up', async () => {
    const api = fakeApi();
    const management = fakeManagement([google]);
    const event = { user: { ...emailUser, email_verified: false } };
    expect(await linkAccounts(event, api, { management, log: vi.fn() })).toBeNull();
    expect(management.usersByEmail).not.toHaveBeenCalled();
    expect(api.authentication.setPrimaryUser).not.toHaveBeenCalled();
  });

  it('does nothing for an untrusted provider, without looking anyone up', async () => {
    const management = fakeManagement([google]);
    const event = { user: user('facebook|5', '2026-06-01T00:00:00.000Z') };
    expect(await linkAccounts(event, fakeApi(), { management, log: vi.fn() })).toBeNull();
    expect(management.usersByEmail).not.toHaveBeenCalled();
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
  type Init = {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    signal?: unknown;
  };
  const res = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  const setup = (users: User[] = [google]) => {
    const store = new Map<string, { value: string; expires_at?: number }>();
    const cache = {
      get: (k: string) => store.get(k),
      set: (k: string, value: string, o?: { expires_at?: number }) => {
        store.set(k, { value, ...o });
      },
      delete: (k: string) => store.delete(k),
    };
    // Like Auth0's users-by-email: an exact, case-sensitive match on the stored address.
    const fetch = vi.fn(async (url: string, _init?: Init) => {
      if (url.endsWith('/oauth/token')) return res({ access_token: 'tok', expires_in: 86400 });
      const q = new URL(url).searchParams.get('email');
      if (q !== null) return res(users.filter((u) => u.email === q));
      return res({}, 201);
    });
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
    expect(await m.usersByEmail(EMAIL)).toEqual([google]);
    await m.usersByEmail(EMAIL);
    const tokenCalls = fetch.mock.calls.filter(([url]) => url.endsWith('/oauth/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.[0]).toBe('https://panote-dev.au.auth0.com/oauth/token');
    expect(JSON.parse(tokenCalls[0]?.[1]?.body ?? '')).toEqual({
      grant_type: 'client_credentials',
      client_id: 'cid',
      client_secret: 'secret',
      audience: 'https://panote-dev.au.auth0.com/api/v2/',
    });
    expect(store.get('mgmt-token')).toEqual({ value: 'tok', expires_at: 1_000 + 86340 * 1000 });
    expect(fetch).toHaveBeenCalledWith(
      'https://panote-dev.au.auth0.com/api/v2/users-by-email?email=maya%40example.com',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer tok' }),
      }),
    );
  });

  it('finds users stored in either case: the address as given and in lower case, de-duplicated', async () => {
    const mixed = { ...github, email: 'Maya@Example.com' };
    const { m, fetch } = setup([google, mixed]);
    expect((await m.usersByEmail('Maya@Example.com')).map((u) => u.user_id).sort()).toEqual([
      'github|333',
      'google-oauth2|111',
    ]);
    const lookups = fetch.mock.calls
      .map(([url]) => url)
      .filter((u) => u.includes('users-by-email'));
    expect(lookups).toEqual([
      'https://panote-dev.au.auth0.com/api/v2/users-by-email?email=Maya%40Example.com',
      'https://panote-dev.au.auth0.com/api/v2/users-by-email?email=maya%40example.com',
    ]);
    // Both forms finding the same user returns it once; an address already in lower case is asked once.
    const both = setup([google, google]);
    expect(await both.m.usersByEmail(EMAIL)).toEqual([google]);
    expect(both.fetch.mock.calls.filter(([u]) => u.includes('users-by-email'))).toHaveLength(1);
  });

  it('shares one token request between the two lookups', async () => {
    const mixed = { ...github, email: 'Maya@Example.com' };
    const { m, fetch } = setup([google, mixed]);
    await m.usersByEmail('Maya@Example.com');
    expect(fetch.mock.calls.filter(([u]) => u.endsWith('/oauth/token'))).toHaveLength(1);
  });

  it('puts a 5 s timeout on every call', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { m, fetch } = setup();
    await m.usersByEmail(EMAIL);
    await m.link('google-oauth2|111', { provider: 'email', user_id: '222' });
    expect(fetch.mock.calls.length).toBe(3);
    for (const [, init] of fetch.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeout.mock.calls).toEqual([[5000], [5000], [5000]]);
    timeout.mockRestore();
  });

  it('gives up on a hung API instead of hanging the login', async () => {
    const fetch = vi.fn(
      (_url: string, init?: Init) =>
        new Promise<never>((_, reject) => {
          (init?.signal as AbortSignal).addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const m = managementClient({
      domain: 'x.auth0.com',
      clientId: 'c',
      clientSecret: 's',
      fetch,
      timeoutMs: 20,
    });
    await expect(m.usersByEmail(EMAIL)).rejects.toThrow('aborted');
  });

  it('links by POSTing the secondary identity, without needing a response body', async () => {
    const { m, fetch } = setup();
    fetch.mockImplementation(async (url: string) =>
      url.endsWith('/oauth/token')
        ? res({ access_token: 'tok', expires_in: 86400 })
        : {
            ok: true,
            status: 201,
            json: async () => {
              throw new SyntaxError('no body');
            },
          },
    );
    await expect(
      m.link('google-oauth2|111', { provider: 'email', user_id: '222' }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenLastCalledWith(
      'https://panote-dev.au.auth0.com/api/v2/users/google-oauth2%7C111/identities',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ provider: 'email', user_id: '222' }),
      }),
    );
  });

  it('on a 401, drops the cached token and tries once more with a fresh one', async () => {
    const { m, fetch, store } = setup();
    store.set('mgmt-token', { value: 'stale' });
    let tokens = 0;
    fetch.mockImplementation(async (url: string, init?: Init) => {
      if (url.endsWith('/oauth/token'))
        return res({ access_token: `fresh${++tokens}`, expires_in: 86400 });
      return init?.headers?.authorization === 'Bearer stale' ? res({}, 401) : res([google]);
    });
    expect(await m.usersByEmail(EMAIL)).toEqual([google]);
    expect(store.get('mgmt-token')?.value).toBe('fresh1');

    fetch.mockImplementation(async (url: string) =>
      url.endsWith('/oauth/token') ? res({ access_token: 'x', expires_in: 86400 }) : res({}, 401),
    );
    await expect(m.usersByEmail(EMAIL)).rejects.toMatchObject({ status: 401 });
  });

  it('throws a ManagementError with the status on a failed call', async () => {
    const fetch = vi.fn(async () => res({}, 403));
    const m = managementClient({ domain: 'x.auth0.com', clientId: 'c', clientSecret: 's', fetch });
    const err = await m.usersByEmail(EMAIL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagementError);
    expect(err).toMatchObject({ status: 403, message: 'management token request failed: 403' });
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
