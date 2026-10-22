// services/upload-api/src/index.test.ts
import {
  accountDeletionKey,
  accountDisabledKey,
  deletingKey,
  encodeId,
  originalKey,
  userPanosPrefix,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, it, expect, beforeAll, vi, type Mock } from 'vitest';

import worker, { UPLOAD_URL_EXPIRY_SECONDS, UPLOAD_URL_RATE_PERIOD_SECONDS } from './index.js';

// Neither account marker (deletion, disabled) exists unless a test says so.
const isMarker = (url: string): boolean =>
  url.endsWith('/deletion.json') || url.endsWith('/disabled.json');

// Maps a HEAD's target key suffix to a canned status, so a single mock can
// drive both the original and tombstone HEADs independently per test.
const mockHeads = (statuses: { original: number; tombstone: number }): Mock =>
  vi.fn(async (input: Request | string) => {
    const reqUrl = typeof input === 'string' ? input : input.url;
    if (isMarker(reqUrl)) return new Response(null, { status: 404 });
    const status = reqUrl.endsWith('/deleting') ? statuses.tombstone : statuses.original;
    return new Response(null, { status });
  });

const validBody = { contentType: 'image/jpeg', size: 1024 };

beforeAll(() => {
  setTestJwtVerifier(async (t: string) => {
    // `throw` rather than `return Promise.reject(...)`: the latter constructs an
    // already-rejected promise before it is returned/awaited, and workerd flags
    // it as an unhandled rejection even though `authenticate`'s try/catch does
    // handle it a tick later.
    if (t !== 'good') throw new Error('bad');
    return { sub: 'auth0|me' };
  });
});

const post = (body?: unknown) =>
  SELF.fetch('https://x/api/upload-url', {
    method: 'POST',
    headers: { Authorization: 'Bearer good', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// An empty ListObjectsV2 page: the owner quotas (set in wrangler.jsonc) list the
// owner's prefix on every request that gets that far.
const emptyListing = (): Response =>
  new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
const isList = (input: Request | string): boolean =>
  new URL(typeof input === 'string' ? input : input.url).searchParams.has('list-type');

// Every request HEADs the account deletion marker first: by default there is none
// (and nothing else exists either). Tests that need other answers stub their own.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string) =>
      isList(input) ? emptyListing() : new Response(null, { status: 404 }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upload-url', () => {
  it('401 without token', async () => {
    const r = await SELF.fetch('https://x/api/upload-url', { method: 'POST' });
    expect(r.status).toBe(401);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await r.json()).toEqual({ error: 'unauthorized' });
  });

  it('401 with a bad token (seam rejects it)', async () => {
    const r = await SELF.fetch('https://x/api/upload-url', {
      method: 'POST',
      headers: { Authorization: 'Bearer bad' },
    });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns a presigned PUT url scoped to the user', async () => {
    const r = await post(validBody);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { panoId: string; key: string; url: string };
    // The owner segment is base64url-encoded; panoId is stored raw
    // (packages/contracts/src/keys.ts).
    expect(j.key).toBe(`panos/${encodeId('auth0|me')}/${j.panoId}/original`);
    expect(j.key).toMatch(/^panos\/[A-Za-z0-9_-]+\/[0-9a-f-]+\/original$/);
    expect(j.url).toContain('X-Amz-Signature=');
  });

  it('presigns with a 10-minute expiry', async () => {
    expect(UPLOAD_URL_EXPIRY_SECONDS).toBe(600);
    const r = await post(validBody);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { url: string };
    expect(new URL(j.url).searchParams.get('X-Amz-Expires')).toBe('600');
  });

  it('pins the content-type and the declared size into the signed URL', async () => {
    const r = await post({ contentType: 'image/webp', size: 1024 });
    expect(r.status).toBe(200);
    const { url } = (await r.json()) as { url: string };
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host',
    );
  });

  it('signs a different URL for a different declared size', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-22T12:00:00Z'), toFake: ['Date'] });
    try {
      const sign = async (size: number) => {
        const r = await post({ contentType: 'image/webp', size, panoId: 'same-pano' });
        const { url } = (await r.json()) as { url: string };
        return new URL(url).searchParams.get('X-Amz-Signature');
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: Request | string) => {
          if (isList(input)) return emptyListing();
          const reqUrl = typeof input === 'string' ? input : input.url;
          return new Response(null, {
            status: isMarker(reqUrl) || reqUrl.endsWith('/deleting') ? 404 : 200,
          });
        }),
      );
      expect(await sign(1024)).not.toBe(await sign(1025));
    } finally {
      vi.useRealTimers();
    }
  });

  it('404 for GET /api/upload-url', async () => {
    const r = await SELF.fetch('https://x/api/upload-url', { method: 'GET' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not found' });
  });

  it('404 for POST /api/nope', async () => {
    const r = await SELF.fetch('https://x/api/nope', { method: 'POST' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not found' });
  });

  describe('content-type validation', () => {
    it('400 when contentType is missing', async () => {
      const r = await post({ size: 1024 });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: expect.stringContaining('image/jpeg') });
    });

    it('400 for a non-image content-type', async () => {
      const r = await post({ contentType: 'text/plain', size: 1024 });
      expect(r.status).toBe(400);
    });

    it('400 for a near-miss image content-type', async () => {
      const r = await post({ contentType: 'image/jpg', size: 1024 });
      expect(r.status).toBe(400);
    });
  });

  describe('size validation', () => {
    const MAX = 150 * 1024 * 1024;

    it('accepts exactly 150 MiB', async () => {
      const r = await post({ contentType: 'image/png', size: MAX });
      expect(r.status).toBe(200);
    });

    it('400 for one byte over 150 MiB', async () => {
      const r = await post({ contentType: 'image/png', size: MAX + 1 });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: expect.stringContaining('150') });
    });

    it('400 when size is missing', async () => {
      const r = await post({ contentType: 'image/png' });
      expect(r.status).toBe(400);
    });

    it('400 for a non-positive size', async () => {
      const r = await post({ contentType: 'image/png', size: 0 });
      expect(r.status).toBe(400);
    });

    it('400 for a non-numeric size', async () => {
      const r = await post({ contentType: 'image/png', size: '1024' });
      expect(r.status).toBe(400);
    });

    it('400 for a non-integer size', async () => {
      const r = await post({ contentType: 'image/png', size: 1.5 });
      expect(r.status).toBe(400);
    });
  });

  describe('replace image (panoId given)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('400 when panoId does not match PANO_PATTERN', async () => {
      const r = await post({ ...validBody, panoId: 'not/a/valid/id' });
      expect(r.status).toBe(400);
    });

    it.each([123, null, '', ['p1'], {}])(
      '400 for a non-string/empty panoId (%j), rather than silently minting a new pano',
      async (panoId) => {
        const r = await post({ ...validBody, panoId });
        expect(r.status).toBe(400);
      },
    );

    it('404 when the caller has no original at that panoId', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 404 })),
      );
      const r = await post({ ...validBody, panoId: 'missing-pano' });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'original not found' });
    });

    it('404 while a delete tombstone exists, even if the original still HEADs ok', async () => {
      vi.stubGlobal('fetch', mockHeads({ original: 200, tombstone: 200 }));
      const r = await post({ ...validBody, panoId: 'being-deleted' });
      expect(r.status).toBe(404);
    });

    it('re-presigns the same key, scoped to the caller, when the original exists and is not tombstoned', async () => {
      const owner = encodeId('auth0|me');
      const fetchMock = vi.fn(async (input: Request | string) => {
        const reqUrl = typeof input === 'string' ? input : input.url;
        // Only the caller's own tombstone key HEADs as missing; everything
        // else (the original) HEADs ok - proves the check is owner-scoped.
        if (reqUrl.includes('/deleting') || isMarker(reqUrl)) {
          return new Response(null, { status: 404 });
        }
        return new Response(null, { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);

      const r = await post({ ...validBody, panoId: 'existing-pano' });
      expect(r.status).toBe(200);
      const j = (await r.json()) as { panoId: string; key: string; url: string };
      expect(j.panoId).toBe('existing-pano');
      expect(j.key).toBe(originalKey('auth0|me', 'existing-pano'));
      expect(j.url).toContain(`${owner}/existing-pano/original`);

      const headUrls = fetchMock.mock.calls.map(([req]) =>
        typeof req === 'string' ? req : (req as Request).url,
      );
      expect(headUrls.some((u) => u.includes(originalKey('auth0|me', 'existing-pano')))).toBe(true);
      expect(headUrls.some((u) => u.includes(deletingKey('auth0|me', 'existing-pano')))).toBe(true);
    });

    it.each([500, 502, 403])(
      'fails closed with 502 (not 404) when the original HEAD errors with %i',
      async (status) => {
        vi.stubGlobal('fetch', mockHeads({ original: status, tombstone: 404 }));
        const r = await post({ ...validBody, panoId: 'flaky-original' });
        expect(r.status).toBe(502);
      },
    );

    it.each([500, 502, 403])(
      'fails closed with 502 (not "no tombstone") when the tombstone HEAD errors with %i',
      async (status) => {
        vi.stubGlobal('fetch', mockHeads({ original: 200, tombstone: status }));
        const r = await post({ ...validBody, panoId: 'flaky-tombstone' });
        expect(r.status).toBe(502);
      },
    );

    it("a persistent 5xx on the original HEAD surfaces as 502 quickly, not after aws4fetch's full retry budget", async () => {
      const fetchMock = mockHeads({ original: 500, tombstone: 404 });
      vi.stubGlobal('fetch', fetchMock);
      const r = await post({ ...validBody, panoId: 'persistently-flaky' });
      expect(r.status).toBe(502);
      // 1 initial + a small configured retry count, not 1 + aws4fetch's default of 10.
      const originalHeads = (fetchMock as Mock).mock.calls.filter(([req]) =>
        (typeof req === 'string' ? req : (req as Request).url).endsWith('/original'),
      );
      expect(originalHeads.length).toBeLessThan(6);
    });
  });
});

describe('upload-url for an account marked for deletion', () => {
  const markerHead = (status: number, disabled = 404) =>
    vi.fn(async (input: Request | string) => {
      const reqUrl = typeof input === 'string' ? input : input.url;
      if (reqUrl.endsWith('/disabled.json')) return new Response(null, { status: disabled });
      return new Response(null, { status: reqUrl.endsWith('/deletion.json') ? status : 200 });
    });

  it.each([
    ['a fresh upload', validBody],
    ['a replace', { ...validBody, panoId: 'existing-pano' }],
  ])('410s %s, after one HEAD of each of its own markers', async (_label, body) => {
    const fetchMock = markerHead(200);
    vi.stubGlobal('fetch', fetchMock);
    const r = await post(body);
    expect(r.status).toBe(410);
    expect(await r.json()).toEqual({ error: 'account deleted' });
    const urls = fetchMock.mock.calls.map(([req]) => (typeof req === 'string' ? req : req.url));
    expect(urls).toHaveLength(2);
    expect(urls.some((u) => u.includes(accountDeletionKey('auth0|me')))).toBe(true);
    expect(urls.some((u) => u.includes(accountDisabledKey('auth0|me')))).toBe(true);
  });

  it('410 wins over 403 when the account is both deleted and disabled', async () => {
    vi.stubGlobal('fetch', markerHead(200, 200));
    expect((await post(validBody)).status).toBe(410);
  });

  it('fails closed with 502 when the marker HEAD errors', async () => {
    vi.stubGlobal('fetch', markerHead(500));
    expect((await post(validBody)).status).toBe(502);
  });
});

describe('upload-url for an account the operator disabled', () => {
  const disabledHead = (status: number) =>
    vi.fn(async (input: Request | string) => {
      const reqUrl = typeof input === 'string' ? input : input.url;
      if (reqUrl.endsWith('/disabled.json')) return new Response(null, { status });
      return new Response(null, { status: reqUrl.endsWith('/deletion.json') ? 404 : 200 });
    });

  it.each([
    ['a fresh upload', validBody],
    ['a replace', { ...validBody, panoId: 'existing-pano' }],
  ])('403s %s without signing anything', async (_label, body) => {
    vi.stubGlobal('fetch', disabledHead(200));
    const r = await post(body);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'account disabled' });
  });

  it('fails closed with 502 when the disabled-marker HEAD errors', async () => {
    vi.stubGlobal('fetch', disabledHead(500));
    expect((await post(validBody)).status).toBe(502);
  });
});

// Calls the Worker directly, so a test can swap a binding or set a var.
const request = (body: unknown) =>
  new Request('https://x/api/upload-url', {
    method: 'POST',
    headers: { Authorization: 'Bearer good', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const call = (body: unknown, overrides: Partial<Env>) =>
  worker.fetch(request(body), { ...env, ...overrides });

describe('upload-url rate limit', () => {
  it('429s with Retry-After, keyed by the owner, before any R2 request', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await call(validBody, { UPLOAD_URL_LIMITER: { limit } });
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe(String(UPLOAD_URL_RATE_PERIOD_SECONDS));
    expect(await r.json()).toEqual({ error: 'rate limited' });
    expect(limit).toHaveBeenCalledWith({ key: 'auth0|me' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is not consulted for an unauthenticated request', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const r = await worker.fetch(new Request('https://x/api/upload-url', { method: 'POST' }), {
      ...env,
      UPLOAD_URL_LIMITER: { limit },
    });
    expect(r.status).toBe(401);
    expect(limit).not.toHaveBeenCalled();
  });

  it('lets the request through while the owner is under the limit', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    expect((await call(validBody, { UPLOAD_URL_LIMITER: { limit } })).status).toBe(200);
  });
});

describe('upload-url owner quotas', () => {
  const prefix = userPanosPrefix('auth0|me');
  const MiB = 1024 * 1024;
  // HEADs: no markers, every original exists, no tombstones. LIST: `objects`.
  const storage = (objects: { key: string; size: number; at?: string }[]) =>
    vi.fn(async (input: Request | string) => {
      const reqUrl = new URL(typeof input === 'string' ? input : input.url);
      if (reqUrl.searchParams.get('list-type') === '2') {
        const contents = objects
          .map(
            (o) =>
              `<Contents><Key>${o.key}</Key><Size>${o.size}</Size>` +
              `<LastModified>${o.at ?? LONG_AGO}</LastModified></Contents>`,
          )
          .join('');
        return new Response(
          `<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        );
      }
      const path = reqUrl.pathname;
      return new Response(null, {
        status: isMarker(path) || path.endsWith('/deleting') ? 404 : 200,
      });
    });
  const LONG_AGO = '2026-01-01T00:00:00.000Z';
  const pano = (id: string, size: number, at = LONG_AGO) => [
    { key: `${prefix}${id}/original`, size, at },
    { key: `${prefix}${id}/config.json`, size: 100, at },
  ];
  // Every limit off, so a test sets only the one it is about.
  const unset = {
    MAX_PANOS_PER_OWNER: '',
    MAX_BYTES_PER_OWNER: '',
    MAX_UPLOADS_PER_OWNER_PER_DAY: '',
  };
  const only = (limits: Partial<Env>) => ({ ...unset, ...limits });
  const lists = (m: Mock) =>
    m.mock.calls.filter(([req]) => new URL((req as Request).url).searchParams.has('list-type'));

  it('unset limits: unlimited, and no listing at all', async () => {
    const fetchMock = storage([...pano('a', 10 * MiB), ...pano('b', 10 * MiB)]);
    vi.stubGlobal('fetch', fetchMock);
    const bare: Partial<Env> = { ...env };
    delete bare.MAX_PANOS_PER_OWNER;
    delete bare.MAX_BYTES_PER_OWNER;
    delete bare.MAX_UPLOADS_PER_OWNER_PER_DAY;
    expect((await worker.fetch(request(validBody), bare as Env)).status).toBe(200);
    expect(lists(fetchMock)).toHaveLength(0);
  });

  it('empty limits count as unset', async () => {
    const fetchMock = storage(pano('a', MiB));
    vi.stubGlobal('fetch', fetchMock);
    const r = await call(validBody, {
      MAX_PANOS_PER_OWNER: '',
      MAX_BYTES_PER_OWNER: ' ',
      MAX_UPLOADS_PER_OWNER_PER_DAY: '',
    });
    expect(r.status).toBe(200);
    expect(lists(fetchMock)).toHaveLength(0);
  });

  it('403s a new pano once the owner holds MAX_PANOS_PER_OWNER', async () => {
    const fetchMock = storage([...pano('a', MiB), ...pano('b', MiB)]);
    vi.stubGlobal('fetch', fetchMock);
    const r = await call(validBody, only({ MAX_PANOS_PER_OWNER: '2' }));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'pano limit reached' });
    expect(new URL((lists(fetchMock)[0]![0] as Request).url).searchParams.get('prefix')).toBe(
      prefix,
    );
  });

  it('allows a new pano under MAX_PANOS_PER_OWNER', async () => {
    vi.stubGlobal('fetch', storage(pano('a', MiB)));
    expect((await call(validBody, only({ MAX_PANOS_PER_OWNER: '2' }))).status).toBe(200);
  });

  it('a replace never counts as a new pano', async () => {
    vi.stubGlobal('fetch', storage([...pano('a', MiB), ...pano('b', MiB)]));
    const r = await call({ ...validBody, panoId: 'a' }, only({ MAX_PANOS_PER_OWNER: '2' }));
    expect(r.status).toBe(200);
  });

  it('403s when the declared size would take the owner past MAX_BYTES_PER_OWNER', async () => {
    vi.stubGlobal('fetch', storage(pano('a', 9 * MiB)));
    const r = await call(
      { contentType: 'image/jpeg', size: MiB + 1 },
      only({ MAX_BYTES_PER_OWNER: String(10 * MiB) }),
    );
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'storage limit reached' });
  });

  it('counts only originals, and allows an upload that lands exactly on the limit', async () => {
    vi.stubGlobal('fetch', storage(pano('a', 9 * MiB)));
    const r = await call(
      { contentType: 'image/jpeg', size: MiB },
      only({ MAX_BYTES_PER_OWNER: String(10 * MiB) }),
    );
    expect(r.status).toBe(200);
  });

  it("a replace frees the old original's bytes", async () => {
    vi.stubGlobal('fetch', storage([...pano('a', 6 * MiB), ...pano('b', 4 * MiB)]));
    const r = await call(
      { contentType: 'image/jpeg', size: 6 * MiB, panoId: 'a' },
      only({ MAX_BYTES_PER_OWNER: String(10 * MiB) }),
    );
    expect(r.status).toBe(200);
  });

  it('a pano being deleted (tombstoned) counts toward neither limit', async () => {
    vi.stubGlobal(
      'fetch',
      storage([
        ...pano('a', 9 * MiB),
        ...pano('b', 9 * MiB),
        { key: `${prefix}b/deleting`, size: 0 },
      ]),
    );
    const r = await call(
      { contentType: 'image/jpeg', size: MiB },
      only({ MAX_PANOS_PER_OWNER: '2', MAX_BYTES_PER_OWNER: String(10 * MiB) }),
    );
    expect(r.status).toBe(200);
  });

  it('fails closed with 502 when the listing errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request) =>
        new URL(input.url).searchParams.has('list-type')
          ? new Response('nope', { status: 500 })
          : new Response(null, { status: 404 }),
      ),
    );
    expect((await call(validBody, only({ MAX_PANOS_PER_OWNER: '5' }))).status).toBe(502);
  });

  it('a malformed limit refuses uploads rather than lifting the limit', async () => {
    vi.stubGlobal('fetch', storage([]));
    const r = await call(validBody, only({ MAX_PANOS_PER_OWNER: 'lots' }));
    expect(r.status).toBe(500);
  });

  describe('replace while over a limit', () => {
    it('403s a replace once the owner holds more than MAX_PANOS_PER_OWNER', async () => {
      vi.stubGlobal('fetch', storage([...pano('a', MiB), ...pano('b', MiB), ...pano('c', MiB)]));
      const r = await call({ ...validBody, panoId: 'a' }, only({ MAX_PANOS_PER_OWNER: '2' }));
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'pano limit reached' });
    });

    it('403s a replace whose new size would take the owner past MAX_BYTES_PER_OWNER', async () => {
      vi.stubGlobal('fetch', storage([...pano('a', MiB), ...pano('b', 9 * MiB)]));
      const r = await call(
        { contentType: 'image/jpeg', size: 2 * MiB, panoId: 'a' },
        only({ MAX_BYTES_PER_OWNER: String(10 * MiB) }),
      );
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'storage limit reached' });
    });
  });

  describe('daily upload limit', () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    const daily = (n: number) => only({ MAX_UPLOADS_PER_OWNER_PER_DAY: String(n) });

    it('403s once the owner has written MAX_UPLOADS_PER_OWNER_PER_DAY originals in 24 hours', async () => {
      vi.stubGlobal(
        'fetch',
        storage([...pano('a', MiB, hoursAgo(1)), ...pano('b', MiB, hoursAgo(23))]),
      );
      const r = await call(validBody, daily(2));
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'daily upload limit reached' });
    });

    it('counts only originals written in the past 24 hours', async () => {
      vi.stubGlobal(
        'fetch',
        storage([...pano('a', MiB, hoursAgo(1)), ...pano('b', MiB, hoursAgo(25))]),
      );
      expect((await call(validBody, daily(2))).status).toBe(200);
    });

    it('applies to a replace too, which re-tiles', async () => {
      vi.stubGlobal(
        'fetch',
        storage([
          ...pano('a', MiB, hoursAgo(1)),
          ...pano('b', MiB, hoursAgo(2)),
          ...pano('old', MiB, hoursAgo(48)),
        ]),
      );
      const r = await call({ ...validBody, panoId: 'old' }, daily(2));
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'daily upload limit reached' });
    });

    it('a replace of a pano already written today does not count it twice', async () => {
      vi.stubGlobal(
        'fetch',
        storage([...pano('a', MiB, hoursAgo(1)), ...pano('b', MiB, hoursAgo(2))]),
      );
      expect((await call({ ...validBody, panoId: 'a' }, daily(2))).status).toBe(200);
    });

    it('a pano being deleted still counts: it was tiled', async () => {
      vi.stubGlobal(
        'fetch',
        storage([
          ...pano('a', MiB, hoursAgo(1)),
          { key: `${prefix}a/deleting`, size: 0, at: hoursAgo(0.5) },
        ]),
      );
      expect((await call(validBody, daily(1))).status).toBe(403);
    });

    it('an original listed without a LastModified counts as recent (fails closed)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: Request) =>
          isList(input)
            ? new Response(
                `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${prefix}a/original</Key><Size>1</Size></Contents></ListBucketResult>`,
              )
            : new Response(null, { status: 404 }),
        ),
      );
      expect((await call(validBody, daily(1))).status).toBe(403);
    });

    it('pano and storage limits are reported before the daily one', async () => {
      vi.stubGlobal('fetch', storage(pano('a', MiB, hoursAgo(1))));
      const r = await call(
        validBody,
        only({ MAX_PANOS_PER_OWNER: '1', MAX_UPLOADS_PER_OWNER_PER_DAY: '1' }),
      );
      expect(await r.json()).toEqual({ error: 'pano limit reached' });
    });

    it('the limits from wrangler.jsonc apply with no override', async () => {
      const today = Array.from({ length: 50 }, (_, i) => pano(`p${i}`, MiB, hoursAgo(1))).flat();
      vi.stubGlobal('fetch', storage(today));
      const r = await post(validBody);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'daily upload limit reached' });
    });
  });

  it('the deletion 410 still comes before any quota listing', async () => {
    const fetchMock = vi.fn(async (input: Request) =>
      input.url.endsWith('/deletion.json')
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect((await call(validBody, only({ MAX_PANOS_PER_OWNER: '0' }))).status).toBe(410);
    expect(lists(fetchMock as Mock)).toHaveLength(0);
  });
});
