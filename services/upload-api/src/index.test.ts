// services/upload-api/src/index.test.ts
import {
  accountDeletionKey,
  accountDisabledKey,
  deletingKey,
  encodeId,
  MAX_PLAN_BYTES,
  originalKey,
  uploadLogKey,
  userPanosPrefix,
  userUploadLogPrefix,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, it, expect, beforeAll, vi, type Mock } from 'vitest';

import worker, {
  MAX_BODY_BYTES,
  MAX_PLAN_BYTES_PER_TOUR,
  UPLOAD_URL_EXPIRY_SECONDS,
  UPLOAD_URL_RATE_PERIOD_SECONDS,
} from './index.js';

// Neither account marker (deletion, disabled) exists unless a test says so.
const isMarker = (url: string): boolean =>
  url.endsWith('/deletion.json') || url.endsWith('/disabled.json');

// The ETag every existing object HEADs with, unless a test says otherwise. A replace
// signs it into the upload URL as If-Match.
const ETAG = '"etag-1"';
// A HEAD answer: a 200 carries an ETag, as R2's always does.
const head = (status: number, etag = ETAG): Response =>
  new Response(null, { status, headers: status === 200 ? { etag } : {} });

// Maps a HEAD's target key suffix to a canned status, so a single mock can
// drive both the original and tombstone HEADs independently per test.
const mockHeads = (statuses: { original: number; tombstone: number }): Mock =>
  vi.fn(async (input: Request | string) => {
    const reqUrl = typeof input === 'string' ? input : input.url;
    if (isMarker(reqUrl)) return new Response(null, { status: 404 });
    const status = reqUrl.endsWith('/deleting') ? statuses.tombstone : statuses.original;
    return head(status);
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
const methodOf = (input: Request | string): string =>
  typeof input === 'string' ? 'GET' : input.method;

// Every request HEADs the account deletion marker first: by default there is none
// (and nothing else exists either). Tests that need other answers stub their own.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string) => {
      if (isList(input)) return emptyListing();
      // The daily limit's upload-log entry.
      if (methodOf(input) === 'PUT') return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    }),
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

  it('presigns with a 2-minute expiry', async () => {
    expect(UPLOAD_URL_EXPIRY_SECONDS).toBe(120);
    const r = await post(validBody);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { url: string };
    expect(new URL(j.url).searchParams.get('X-Amz-Expires')).toBe('120');
  });

  it('pins the content-type, the declared size and create-only into the signed URL', async () => {
    const r = await post({ contentType: 'image/webp', size: 1024 });
    expect(r.status).toBe(200);
    const { url, headers } = (await r.json()) as { url: string; headers: unknown };
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match',
    );
    // The PUT must send exactly these: a second PUT to the URL gets 412 from R2.
    expect(headers).toEqual({ 'content-type': 'image/webp', 'if-none-match': '*' });
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
          return head(isMarker(reqUrl) || reqUrl.endsWith('/deleting') ? 404 : 200);
        }),
      );
      expect(await sign(1024)).not.toBe(await sign(1025));
    } finally {
      vi.useRealTimers();
    }
  });

  it('404 for PUT /api/upload-url (GET is the usage read)', async () => {
    const r = await SELF.fetch('https://x/api/upload-url', { method: 'PUT' });
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

    it('413 for a body past MAX_BODY_BYTES, before any R2 request', async () => {
      const fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
      vi.stubGlobal('fetch', fetchSpy);
      const r = await post({ ...validBody, pad: 'x'.repeat(MAX_BODY_BYTES) });
      expect(r.status).toBe(413);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('400 for a panoId over 64 characters, never building a key from it', async () => {
      const long = 'p'.repeat(65);
      const fetchSpy = vi.fn(
        async (_input: Request | string) => new Response(null, { status: 404 }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const r = await post({ ...validBody, panoId: long });
      expect(r.status).toBe(400);
      const urls = fetchSpy.mock.calls.map(([input]) =>
        typeof input === 'string' ? input : input.url,
      );
      expect(urls.some((u) => u.includes(long))).toBe(false);
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
        return head(200);
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

    // These use `call` (below), off the real per-minute limiter this file's `post`s share.
    it('pins the original’s current ETag as If-Match, so the URL overwrites it only once', async () => {
      vi.stubGlobal('fetch', mockHeads({ original: 200, tombstone: 404 }));
      const r = await call({ contentType: 'image/png', size: 1024, panoId: 'existing-pano' }, {});
      expect(r.status).toBe(200);
      const { url, headers } = (await r.json()) as { url: string; headers: unknown };
      expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-length;content-type;host;if-match',
      );
      expect(headers).toEqual({ 'content-type': 'image/png', 'if-match': ETAG });
    });

    it('signs a different URL for a different current ETag', async () => {
      vi.useFakeTimers({ now: new Date('2026-10-22T12:00:00Z'), toFake: ['Date'] });
      try {
        const sign = async (etag: string) => {
          vi.stubGlobal(
            'fetch',
            vi.fn(async (input: Request | string) => {
              if (isList(input)) return emptyListing();
              const reqUrl = typeof input === 'string' ? input : input.url;
              return head(isMarker(reqUrl) || reqUrl.endsWith('/deleting') ? 404 : 200, etag);
            }),
          );
          const r = await call({ ...validBody, panoId: 'same-pano' }, {});
          const { url } = (await r.json()) as { url: string };
          return new URL(url).searchParams.get('X-Amz-Signature');
        };
        expect(await sign('"etag-1"')).not.toBe(await sign('"etag-2"'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('fails closed with 502, and no URL, when the original HEADs with no ETag', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: Request | string) => {
          if (isList(input)) return emptyListing();
          const reqUrl = typeof input === 'string' ? input : input.url;
          if (reqUrl.endsWith('/original')) return new Response(null, { status: 200 });
          // The upload log write would succeed: only the missing ETag refuses.
          if (methodOf(input) === 'PUT') return new Response(null, { status: 200 });
          return new Response(null, { status: 404 });
        }),
      );
      const r = await call({ ...validBody, panoId: 'no-etag' }, {});
      expect(r.status).toBe(502);
      expect(await r.json()).not.toHaveProperty('url');
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
// Runs the Worker with a real ExecutionContext and waits for its waitUntil work.
const run = async (req: Request, e: Env): Promise<Response> => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};
// The real per-minute limiter is shared by every test in this file, so `call`
// swaps in one that always lets through, unless a test brings its own.
const unlimited = { limit: async () => ({ success: true }) };
const call = (body: unknown, overrides: Partial<Env>) =>
  run(request(body), { ...env, UPLOAD_URL_LIMITER: unlimited, ...overrides });

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
    const r = await run(new Request('https://x/api/upload-url', { method: 'POST' }), {
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
  // HEADs: no markers, every original exists, no tombstones. PUTs (the upload
  // log) succeed. LIST: the `objects` under the listed prefix.
  const storage = (objects: { key: string; size: number }[]) =>
    vi.fn(async (input: Request | string) => {
      const reqUrl = new URL(typeof input === 'string' ? input : input.url);
      if (reqUrl.searchParams.get('list-type') === '2') {
        const listed = reqUrl.searchParams.get('prefix') ?? '';
        const contents = objects
          .filter((o) => o.key.startsWith(listed))
          .map((o) => `<Contents><Key>${o.key}</Key><Size>${o.size}</Size></Contents>`)
          .join('');
        return new Response(
          `<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        );
      }
      const path = reqUrl.pathname;
      return head(isMarker(path) || path.endsWith('/deleting') ? 404 : 200);
    });
  const pano = (id: string, size: number) => [
    { key: `${prefix}${id}/original`, size },
    { key: `${prefix}${id}/config.json`, size: 100 },
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
    expect((await run(request(validBody), bare as Env)).status).toBe(200);
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
    const logPrefix = userUploadLogPrefix('auth0|me');
    let n = 0;
    // One upload-log entry, issued `h` hours ago.
    const issued = (h: number) => ({
      key: uploadLogKey('auth0|me', new Date(Date.now() - h * 3600_000), `p${n++}`),
      size: 0,
    });
    const daily = (max: number) => only({ MAX_UPLOADS_PER_OWNER_PER_DAY: String(max) });
    const calls = (m: Mock, method: string) =>
      m.mock.calls
        .map(([req]) => req as Request)
        .filter((req) => req.method === method && !new URL(req.url).searchParams.has('list-type'))
        .map((req) => decodeURIComponent(new URL(req.url).pathname));

    it('403s once the owner got MAX_UPLOADS_PER_OWNER_PER_DAY URLs in 24 hours, and logs nothing', async () => {
      const fetchMock = storage([issued(1), issued(23)]);
      vi.stubGlobal('fetch', fetchMock);
      const r = await call(validBody, daily(2));
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'daily upload limit reached' });
      expect(calls(fetchMock, 'PUT')).toEqual([]);
    });

    it('logs the URL it issues under upload-log/<owner>/, outside panos/', async () => {
      const fetchMock = storage([issued(1)]);
      vi.stubGlobal('fetch', fetchMock);
      const r = await call(validBody, daily(2));
      expect(r.status).toBe(200);
      const { panoId } = (await r.json()) as { panoId: string };
      const puts = calls(fetchMock, 'PUT');
      expect(puts).toHaveLength(1);
      expect(puts[0]).toMatch(new RegExp(`/${logPrefix}\\d{8}T\\d{9}Z-${panoId}$`));
      expect(
        lists(fetchMock).map(([req]) => new URL((req as Request).url).searchParams.get('prefix')),
      ).toEqual([logPrefix]);
    });

    it('counts URLs, not stored originals: an upload deleted again still counts', async () => {
      // Nothing under panos/ at all, but two URLs issued today.
      vi.stubGlobal('fetch', storage([issued(2), issued(3)]));
      expect((await call(validBody, daily(2))).status).toBe(403);
    });

    it('every replace counts, even of the same pano', async () => {
      const fetchMock = storage([...pano('a', MiB), issued(1)]);
      vi.stubGlobal('fetch', fetchMock);
      expect((await call({ ...validBody, panoId: 'a' }, daily(2))).status).toBe(200);
      const again = storage([...pano('a', MiB), issued(1), issued(0)]);
      vi.stubGlobal('fetch', again);
      const r = await call({ ...validBody, panoId: 'a' }, daily(2));
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'daily upload limit reached' });
    });

    it('entries older than 24 hours do not count, and are deleted', async () => {
      const old = [issued(25), issued(48)];
      const fetchMock = storage([issued(1), ...old]);
      vi.stubGlobal('fetch', fetchMock);
      expect((await call(validBody, daily(2))).status).toBe(200);
      expect(calls(fetchMock, 'DELETE').sort()).toEqual(
        old.map((o) => `/${env.R2_BUCKET}/${o.key}`).sort(),
      );
    });

    it('a malformed entry does not count, and is deleted', async () => {
      const fetchMock = storage([{ key: `${logPrefix}junk`, size: 0 }]);
      vi.stubGlobal('fetch', fetchMock);
      expect((await call(validBody, daily(1))).status).toBe(200);
      expect(calls(fetchMock, 'DELETE')).toEqual([`/${env.R2_BUCKET}/${logPrefix}junk`]);
    });

    it('prunes at most UPLOAD_LOG_PRUNE_MAX entries per request', async () => {
      const fetchMock = storage(Array.from({ length: 60 }, () => issued(30)));
      vi.stubGlobal('fetch', fetchMock);
      expect((await call(validBody, daily(1))).status).toBe(200);
      expect(calls(fetchMock, 'DELETE')).toHaveLength(50);
    });

    it('a failed prune still answers', async () => {
      const base = storage([issued(30)]);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: Request) =>
          input.method === 'DELETE' ? new Response(null, { status: 500 }) : base(input),
        ),
      );
      expect((await call(validBody, daily(1))).status).toBe(200);
    });

    it('fails closed with 502, and no URL, when the log entry cannot be written', async () => {
      const base = storage([]);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: Request) =>
          input.method === 'PUT' ? new Response(null, { status: 403 }) : base(input),
        ),
      );
      const r = await call(validBody, daily(5));
      expect(r.status).toBe(502);
      expect(await r.json()).not.toHaveProperty('url');
    });

    it('fails closed with 502 when the log listing errors', async () => {
      const base = storage([]);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: Request) =>
          isList(input) ? new Response('nope', { status: 500 }) : base(input),
        ),
      );
      expect((await call(validBody, daily(5))).status).toBe(502);
    });

    it('unset: no log listing and no log entry', async () => {
      const fetchMock = storage([]);
      vi.stubGlobal('fetch', fetchMock);
      expect((await call(validBody, only({}))).status).toBe(200);
      expect(lists(fetchMock)).toHaveLength(0);
      expect(calls(fetchMock, 'PUT')).toEqual([]);
    });

    it('pano and storage limits are reported before the daily one', async () => {
      vi.stubGlobal('fetch', storage([...pano('a', MiB), issued(1)]));
      const r = await call(
        validBody,
        only({ MAX_PANOS_PER_OWNER: '1', MAX_UPLOADS_PER_OWNER_PER_DAY: '1' }),
      );
      expect(await r.json()).toEqual({ error: 'pano limit reached' });
    });

    it('the limits from wrangler.jsonc apply with no override', async () => {
      vi.stubGlobal('fetch', storage(Array.from({ length: 50 }, () => issued(1))));
      const r = await call(validBody, {});
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

describe('upload-url for a floor-plan image (kind: plan)', () => {
  const planBody = { kind: 'plan', tourId: 'tour-1', contentType: 'image/webp', size: 2048 };
  const tourJson = `tours/${encodeId('auth0|me')}/tour-1/tour.json`;
  // HEADs: the caller's tour.json exists (unless `tour` says otherwise), no markers;
  // PUTs (the upload log) succeed; LISTs are empty.
  const stub = ({ tour = 200 }: { tour?: number } = {}) =>
    vi.fn(async (input: Request | string) => {
      if (isList(input)) return emptyListing();
      const reqUrl = typeof input === 'string' ? input : input.url;
      if (decodeURIComponent(new URL(reqUrl).pathname).endsWith(tourJson)) {
        return new Response(null, { status: tour });
      }
      if (methodOf(input) === 'PUT') return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });

  it('presigns a fresh, owner-free key under the tour’s public plan prefix', async () => {
    const fetchMock = stub();
    vi.stubGlobal('fetch', fetchMock);
    const r = await post(planBody);
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      planId: string;
      key: string;
      url: string;
      headers: unknown;
    };
    expect(j.key).toBe(`pub/plans/tour-1/${j.planId}.webp`);
    expect(j.key).not.toContain(encodeId('auth0|me'));
    const url = new URL(j.url);
    expect(decodeURIComponent(url.pathname)).toMatch(new RegExp(`/${j.key}$`));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match',
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    // A fresh key: create-only, so the URL can be PUT to once.
    expect(j.headers).toEqual({ 'content-type': 'image/webp', 'if-none-match': '*' });
    // Checked the caller owns the tour.
    const heads = fetchMock.mock.calls
      .map(([req]) => req as Request)
      .filter((req) => req.method === 'HEAD')
      .map((req) => decodeURIComponent(new URL(req.url).pathname));
    expect(heads.some((p) => p.endsWith(tourJson))).toBe(true);
    // A second URL is a new key, so a replaced image is never served stale.
    const again = (await (await post(planBody)).json()) as { key: string };
    expect(again.key).not.toBe(j.key);
  });

  it('names the key after the image type', async () => {
    vi.stubGlobal('fetch', stub());
    const png = (await (await post({ ...planBody, contentType: 'image/png' })).json()) as {
      key: string;
    };
    expect(png.key).toMatch(/\.png$/);
    const jpg = (await (await post({ ...planBody, contentType: 'image/jpeg' })).json()) as {
      key: string;
    };
    expect(jpg.key).toMatch(/\.jpg$/);
  });

  it.each([
    ['a number', 5],
    ['a string', 'plan'],
    ['true', true],
    ['an array', [planBody]],
  ])('400s, not 500s, on a body that is %s', async (_, body) => {
    vi.stubGlobal('fetch', stub());
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'body must be a JSON object' });
  });

  it('404s for a tour the caller does not have', async () => {
    vi.stubGlobal('fetch', stub({ tour: 404 }));
    const r = await post(planBody);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'tour not found' });
  });

  it('fails closed with 502 when the tour HEAD errors', async () => {
    vi.stubGlobal('fetch', stub({ tour: 500 }));
    expect((await post(planBody)).status).toBe(502);
  });

  it('caps the size at 4 MiB, not 150 MiB', async () => {
    vi.stubGlobal('fetch', stub());
    expect((await post({ ...planBody, size: 4 * 1024 * 1024 })).status).toBe(200);
    const r = await post({ ...planBody, size: 4 * 1024 * 1024 + 1 });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/4 MiB/);
  });

  it('400s a bad tourId, a missing one, a bad type and an unknown kind', async () => {
    vi.stubGlobal('fetch', stub());
    expect((await post({ ...planBody, tourId: '../x' })).status).toBe(400);
    expect((await post({ ...planBody, tourId: 't'.repeat(65) })).status).toBe(400);
    const { tourId: _gone, ...noTour } = planBody;
    expect((await post(noTour)).status).toBe(400);
    expect((await post({ ...planBody, contentType: 'image/svg+xml' })).status).toBe(400);
    expect((await post({ ...planBody, kind: 'avatar' })).status).toBe(400);
  });

  it('410s for an account marked for deletion, before the tour HEAD', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request) =>
        input.url.endsWith('/deletion.json')
          ? new Response(null, { status: 200 })
          : new Response(null, { status: 404 }),
      ),
    );
    expect((await post(planBody)).status).toBe(410);
  });

  it('counts toward the daily upload limit, logging the planId', async () => {
    const fetchMock = stub();
    vi.stubGlobal('fetch', fetchMock);
    const r = await call(planBody, { MAX_UPLOADS_PER_OWNER_PER_DAY: '5' });
    expect(r.status).toBe(200);
    const { planId } = (await r.json()) as { planId: string };
    const puts = fetchMock.mock.calls
      .map(([req]) => req as Request)
      .filter((req) => req.method === 'PUT')
      .map((req) => decodeURIComponent(new URL(req.url).pathname));
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatch(
      new RegExp(`/${userUploadLogPrefix('auth0|me')}\\d{8}T\\d{9}Z-${planId}$`),
    );
  });

  it('403s at the daily upload limit', async () => {
    const full = vi.fn(async (input: Request | string) => {
      const reqUrl = new URL(typeof input === 'string' ? input : input.url);
      if (reqUrl.searchParams.get('list-type') === '2') {
        const key = uploadLogKey('auth0|me', new Date(Date.now() - 3600_000), 'p1');
        return new Response(
          `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key><Size>0</Size></Contents></ListBucketResult>`,
        );
      }
      if (decodeURIComponent(reqUrl.pathname).endsWith(tourJson)) {
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', full);
    const r = await call(planBody, { MAX_UPLOADS_PER_OWNER_PER_DAY: '1' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'daily upload limit reached' });
  });
});

describe('upload-url global daily ceiling', () => {
  const ceiling = () => env.UPLOAD_CEILING.get(env.UPLOAD_CEILING.idFromName('global'));
  const today = async () => {
    const { uploads, bytes } = await ceiling().count(Date.now());
    return { uploads, bytes };
  };
  // The default storage stub (beforeEach), kept so a test can read its calls.
  const storage = (put = 200) =>
    vi.fn(async (input: Request | string) => {
      if (isList(input)) return emptyListing();
      if (methodOf(input) === 'PUT') return new Response(null, { status: put });
      return new Response(null, { status: 404 });
    });
  const puts = (m: Mock) => m.mock.calls.filter(([req]) => methodOf(req as Request) === 'PUT');
  // A stand-in for the DO namespace whose instance throws on every call. (`throw`, not
  // Promise.reject: workerd flags an already-rejected promise as unhandled.)
  const unreachable = () => {
    const reserve = vi.fn(async () => {
      throw new Error('DO down');
    });
    return { idFromName: () => ({}), get: () => ({ reserve }) } as unknown as Env['UPLOAD_CEILING'];
  };

  it('reserves one upload and its declared bytes for each URL issued', async () => {
    const before = await today();
    expect((await call(validBody, {})).status).toBe(200);
    expect(await today()).toEqual({
      uploads: before.uploads + 1,
      bytes: before.bytes + validBody.size,
    });
  });

  it('503s until 00:00 UTC, and logs no upload, once the ceiling is reached', async () => {
    const fetchMock = storage();
    vi.stubGlobal('fetch', fetchMock);
    const r = await call(validBody, { MAX_UPLOADS_PER_DAY_GLOBAL: '0' });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'uploads paused' });
    const retryAfter = Number(r.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
    expect(puts(fetchMock)).toEqual([]);
  });

  it('the byte limit pauses uploads too', async () => {
    const r = await call(validBody, {
      MAX_UPLOAD_BYTES_PER_DAY_GLOBAL: String(validBody.size - 1),
    });
    expect(r.status).toBe(503);
  });

  it('the limits from wrangler.jsonc apply with no override', async () => {
    expect(env.MAX_UPLOADS_PER_DAY_GLOBAL).toBe('2000');
    expect(env.MAX_UPLOAD_BYTES_PER_DAY_GLOBAL).toBe(String(200 * 1024 ** 3));
  });

  it("a request refused by the owner's own quota reserves nothing", async () => {
    const before = await today();
    const r = await call(validBody, { MAX_PANOS_PER_OWNER: '0' });
    expect(r.status).toBe(403);
    expect(await today()).toEqual(before);
  });

  // The real global instance, with its reserve and release calls recorded, so a test
  // can show a reservation was taken before it was given back.
  const watched = () => {
    const real = ceiling();
    const reserved: unknown[] = [];
    const released: unknown[] = [];
    const ns = {
      idFromName: () => ({}),
      get: () => ({
        reserve: async (...a: Parameters<typeof real.reserve>) => {
          const held = await real.reserve(...a);
          reserved.push(held);
          return held;
        },
        release: async (...a: Parameters<typeof real.release>) => {
          released.push(a[0]);
          await real.release(...a);
        },
      }),
    } as unknown as Env['UPLOAD_CEILING'];
    return { ns, reserved, released };
  };
  // Takes a reservation, then fails: it must be given back, leaving the count as it was.
  const releasedAfterFailure = async (body: unknown, status: number) => {
    const w = watched();
    const before = await today();
    expect((await call(body, { UPLOAD_CEILING: w.ns })).status).toBe(status);
    expect(w.reserved).toHaveLength(1);
    expect(w.reserved[0]).not.toBeNull();
    expect(w.released).toEqual(w.reserved);
    expect(await today()).toEqual(before);
  };

  it('gives the reservation back when the upload log cannot be written', async () => {
    vi.stubGlobal('fetch', storage(500));
    await releasedAfterFailure(validBody, 502);
  });

  // Lets every request through, then fails the signing that comes after the upload-log
  // PUT, which is the URL's own presign: the last step before the URL goes out.
  const presignFails = (base: Mock = storage()) => {
    let logged = false;
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
      if (logged) throw new Error('presign failed');
      return sign(...args);
    });
    return vi.fn(async (input: Request | string) => {
      const res = await base(input);
      if (methodOf(input) === 'PUT') logged = true;
      return res;
    });
  };

  it('gives the reservation back when signing the URL fails', async () => {
    vi.stubGlobal('fetch', presignFails());
    await releasedAfterFailure(validBody, 500);
  });

  it('unset limits: no DO call at all', async () => {
    const get = vi.fn();
    const r = await call(validBody, {
      MAX_UPLOADS_PER_DAY_GLOBAL: '',
      MAX_UPLOAD_BYTES_PER_DAY_GLOBAL: '',
      UPLOAD_CEILING: { idFromName: () => ({}), get } as unknown as Env['UPLOAD_CEILING'],
    });
    expect(r.status).toBe(200);
    expect(get).not.toHaveBeenCalled();
  });

  it('a malformed limit refuses uploads rather than lifting the limit', async () => {
    expect((await call(validBody, { MAX_UPLOADS_PER_DAY_GLOBAL: 'lots' })).status).toBe(500);
  });

  it('fails open on a DO blip, closed once it keeps failing, and recovers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down = { UPLOAD_CEILING: unreachable() };
    expect((await call(validBody, down)).status).toBe(200);
    expect((await call(validBody, down)).status).toBe(200);
    const closed = await call(validBody, down);
    expect(closed.status).toBe(502);
    expect(await closed.json()).toEqual({ error: 'storage unavailable' });
    // One call that gets through starts the count again.
    expect((await call(validBody, {})).status).toBe(200);
    expect((await call(validBody, down)).status).toBe(200);
    expect((await call(validBody, {})).status).toBe(200);
  });

  describe('floor-plan images', () => {
    const planBody = { kind: 'plan', tourId: 'tour-1', contentType: 'image/webp', size: 2048 };
    const tourJson = `tours/${encodeId('auth0|me')}/tour-1/tour.json`;
    // The tour exists; its plan prefix holds `plans` (sizes); PUTs succeed.
    const stub = (plans: number[] = []) =>
      vi.fn(async (input: Request | string) => {
        const reqUrl = new URL(typeof input === 'string' ? input : input.url);
        if (reqUrl.searchParams.get('list-type') === '2') {
          const prefix = reqUrl.searchParams.get('prefix') ?? '';
          const contents = prefix.startsWith('pub/plans/tour-1/')
            ? plans
                .map(
                  (size, i) =>
                    `<Contents><Key>${prefix}p${i}.webp</Key><Size>${size}</Size></Contents>`,
                )
                .join('')
            : '';
          return new Response(
            `<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
          );
        }
        if (decodeURIComponent(reqUrl.pathname).endsWith(tourJson)) {
          return new Response(null, { status: 200 });
        }
        if (methodOf(input) === 'PUT') return new Response(null, { status: 200 });
        return new Response(null, { status: 404 });
      });

    it('count toward the ceiling, and are paused with it', async () => {
      vi.stubGlobal('fetch', stub());
      const before = await today();
      expect((await call(planBody, {})).status).toBe(200);
      expect(await today()).toEqual({
        uploads: before.uploads + 1,
        bytes: before.bytes + planBody.size,
      });
      const r = await call(planBody, { MAX_UPLOADS_PER_DAY_GLOBAL: '0' });
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: 'uploads paused' });
    });

    it('give the reservation back when signing the URL fails', async () => {
      vi.stubGlobal('fetch', presignFails(stub()));
      await releasedAfterFailure(planBody, 500);
    });

    it('403 once the tour’s plan images would pass MAX_PLAN_BYTES_PER_TOUR', async () => {
      const room = MAX_PLAN_BYTES_PER_TOUR - planBody.size;
      vi.stubGlobal('fetch', stub([room - MAX_PLAN_BYTES, MAX_PLAN_BYTES]));
      expect((await call(planBody, {})).status).toBe(200);
      vi.stubGlobal('fetch', stub([room - MAX_PLAN_BYTES, MAX_PLAN_BYTES + 1]));
      const r = await call(planBody, {});
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'plan storage limit reached' });
    });

    it('fails closed with 502 when the plan listing errors', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: Request | string) => {
          const reqUrl = new URL(typeof input === 'string' ? input : input.url);
          if (reqUrl.searchParams.get('list-type') === '2')
            return new Response(null, { status: 500 });
          return new Response(null, {
            status: decodeURIComponent(reqUrl.pathname).endsWith(tourJson) ? 200 : 404,
          });
        }),
      );
      expect((await call(planBody, {})).status).toBe(502);
    });
  });
});

describe('operator events', () => {
  const sink = () => {
    const writeDataPoint = vi.fn<(p: AnalyticsEngineDataPoint) => void>();
    return { writeDataPoint, events: () => writeDataPoint.mock.calls.map(([p]) => p.blobs) };
  };

  it('records each upload URL it hands out, by kind and size, and nothing about who', async () => {
    const s = sink();
    expect((await call(validBody, { OPS_EVENTS: s })).status).toBe(200);
    expect(s.events()).toEqual([['upload-url', 'new', 'upload-api', 'o1']]);
    expect(s.writeDataPoint.mock.calls[0]?.[0].doubles).toEqual([1024]);
  });

  it('records a refusal by its reason code, never the error text', async () => {
    const s = sink();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string) => {
        const reqUrl = typeof input === 'string' ? input : input.url;
        return new Response(null, { status: reqUrl.endsWith('/disabled.json') ? 200 : 404 });
      }),
    );
    expect((await call(validBody, { OPS_EVENTS: s })).status).toBe(403);
    expect(s.events()).toEqual([['upload-refused', 'account-disabled', 'upload-api', 'o1']]);
  });

  it('records a rate-limit refusal once, as rate-limited', async () => {
    const s = sink();
    const limit = async () => ({ success: false });
    expect((await call(validBody, { OPS_EVENTS: s, UPLOAD_URL_LIMITER: { limit } })).status).toBe(
      429,
    );
    expect(s.events()).toEqual([['rate-limited', 'UPLOAD_URL_LIMITER', 'upload-api', 'o1']]);
  });

  it('records nothing for a bad request, a usage read or another path', async () => {
    const s = sink();
    await call({ contentType: 'image/gif', size: 1 }, { OPS_EVENTS: s });
    await run(
      new Request('https://x/api/upload-url', { headers: { Authorization: 'Bearer good' } }),
      {
        ...env,
        UPLOAD_URL_LIMITER: unlimited,
        OPS_EVENTS: s,
      },
    );
    await run(new Request('https://x/api/nope', { method: 'POST' }), { ...env, OPS_EVENTS: s });
    expect(s.events()).toEqual([]);
  });
});
