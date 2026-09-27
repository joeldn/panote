import { afterEach, describe, expect, it, vi } from 'vitest';

import { mergePurges, purgeCdn, type PurgeEnv } from './purge.js';

const TOKEN = 'secret-purge-token-value';
const ZONE = '0123456789abcdef0123456789abcdef';
const CONFIGURED: PurgeEnv = {
  CF_PURGE_TOKEN: TOKEN,
  CDN_ZONE_ID: ZONE,
  CDN_HOST: 'cdn.panote.dev',
};

type Call = { url: string; init: RequestInit };

const recordingFetch = (respond: () => Promise<Response> = async () => Response.json({})) => {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return await respond();
  }) as unknown as typeof fetch;
  return { fn, calls, bodies: () => calls.map((c) => JSON.parse(String(c.init.body))) };
};

const logSpies = () => ({
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
});

const allLogged = (spies: ReturnType<typeof logSpies>): string =>
  [...spies.error.mock.calls, ...spies.warn.mock.calls].flat().map(String).join('\n');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('purgeCdn', () => {
  it('purges a prefix without a scheme, via the zone purge endpoint', async () => {
    const f = recordingFetch();
    await purgeCdn(CONFIGURED, { prefixes: ['tiles/p1/'], files: [] }, { fetch: f.fn });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`);
    expect(f.calls[0]?.init.method).toBe('POST');
    expect(new Headers(f.calls[0]?.init.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(f.bodies()).toEqual([{ prefixes: ['cdn.panote.dev/tiles/p1/'] }]);
  });

  it('purges files by full URL, in a separate request from prefixes', async () => {
    const f = recordingFetch();
    await purgeCdn(
      CONFIGURED,
      { prefixes: ['tiles/p1/'], files: ['pub/tours/t1.json', 'slugs/s1.json'] },
      { fetch: f.fn },
    );
    expect(f.bodies()).toEqual([
      { prefixes: ['cdn.panote.dev/tiles/p1/'] },
      {
        files: ['https://cdn.panote.dev/pub/tours/t1.json', 'https://cdn.panote.dev/slugs/s1.json'],
      },
    ]);
  });

  it('batches prefixes 100 per request', async () => {
    const f = recordingFetch();
    const prefixes = Array.from({ length: 150 }, (_, i) => `tiles/p${i}/`);
    await purgeCdn(CONFIGURED, { prefixes, files: [] }, { fetch: f.fn });
    expect(f.bodies().map((b: { prefixes: string[] }) => b.prefixes.length)).toEqual([100, 50]);
  });

  it('makes no call for an empty purge', async () => {
    const f = recordingFetch();
    const spies = logSpies();
    await purgeCdn(CONFIGURED, { prefixes: [], files: [] }, { fetch: f.fn });
    expect(f.calls).toHaveLength(0);
    expect(spies.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['the token is unset', { ...CONFIGURED, CF_PURGE_TOKEN: undefined }],
    ['the token is empty', { ...CONFIGURED, CF_PURGE_TOKEN: '' }],
    ['the zone id is a placeholder', { ...CONFIGURED, CDN_ZONE_ID: 'YOUR_PANOTE_DEV_ZONE_ID' }],
    ['the host is empty', { ...CONFIGURED, CDN_HOST: '' }],
  ])('makes no call and warns when %s', async (_, env) => {
    const f = recordingFetch();
    const spies = logSpies();
    await purgeCdn(env, { prefixes: ['tiles/p1/'], files: [] }, { fetch: f.fn });
    expect(f.calls).toHaveLength(0);
    expect(spies.warn).toHaveBeenCalledOnce();
    expect(allLogged(spies)).not.toContain(TOKEN);
  });

  it.each([
    [
      'a non-2xx',
      () =>
        Promise.resolve(
          Response.json(
            { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
            { status: 403 },
          ),
        ),
      'HTTP 403: 10000 Authentication error',
    ],
    ['a 429', () => Promise.resolve(new Response('slow down', { status: 429 })), 'HTTP 429'],
    ['a rejected fetch', () => Promise.reject(new TypeError(`boom ${TOKEN}`)), 'TypeError'],
  ])('logs %s without throwing or leaking the token', async (_, respond, expected) => {
    const f = recordingFetch(respond);
    const spies = logSpies();
    await expect(
      purgeCdn(CONFIGURED, { prefixes: ['tiles/p1/'], files: ['a.json'] }, { fetch: f.fn }),
    ).resolves.toBeUndefined();
    // One failed batch doesn't stop the next one.
    expect(f.calls).toHaveLength(2);
    expect(spies.error).toHaveBeenCalledTimes(2);
    expect(allLogged(spies)).toContain(expected);
    expect(allLogged(spies)).not.toContain(TOKEN);
  });

  it('times out a hung purge request', async () => {
    const hung = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const spies = logSpies();
    await expect(
      purgeCdn(CONFIGURED, { prefixes: ['tiles/p1/'], files: [] }, { fetch: hung, timeoutMs: 20 }),
    ).resolves.toBeUndefined();
    expect(allLogged(spies)).toContain('TimeoutError');
  });
});

describe('mergePurges', () => {
  it('unions and dedupes', () => {
    expect(
      mergePurges(
        { prefixes: ['tiles/a/'], files: ['x.json'] },
        { prefixes: ['tiles/a/', 'tiles/b/'], files: ['x.json'] },
      ),
    ).toEqual({ prefixes: ['tiles/a/', 'tiles/b/'], files: ['x.json'] });
  });
});
