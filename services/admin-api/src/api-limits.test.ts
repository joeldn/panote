// admin-api's read limits (per owner, Insights on top), the operator routes' per-IP
// limit, the capped write bodies and the id length check on route params.
import {
  MAX_HOTSPOT_BODY_LENGTH,
  MAX_HOTSPOTS,
  MAX_ID_LENGTH,
  MAX_MEDIA_URL_LENGTH,
  MAX_SCENE_DESCRIPTION_LENGTH,
  MAX_SCENE_TRANSLATION_CHARS,
  MAX_TITLE_LENGTH,
  OPERATOR_RESTORE_PATH,
  OPERATOR_TAKEDOWN_PATH,
  OPERATOR_TOKEN_HEADER,
  originalKey,
  SceneConfigSchema,
  tourKey,
  userToursPrefix,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import worker from './index.js';
import {
  MAX_CONFIG_BODY_BYTES,
  MAX_WRITE_BODY_BYTES,
  WRITE_RATE_PERIOD_SECONDS,
} from './limits.js';

const SUB = 'auth0|api-limits';

beforeAll(() => {
  setTestJwtVerifier(async (t) => (t === 'good' ? { sub: SUB } : Promise.reject(new Error('bad'))));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const bearer = { Authorization: 'Bearer good' };

const call = async (path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://x${path}`, init),
    { ...env, CF_ANALYTICS_TOKEN: 'test-token', ...overrides } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
};

const limiter = (success: boolean) => ({ limit: vi.fn(async () => ({ success })) });

// A body sent chunked (no Content-Length): `count` chunks of `size` bytes.
const chunked = (count: number, size: number) => {
  let sent = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent === count) return controller.close();
        sent += 1;
        controller.enqueue(new Uint8Array(size).fill(0x20));
      },
    },
    { highWaterMark: 0 },
  );
};

describe('per-owner read rate limit', () => {
  it.each([
    '/api/admin/panos',
    '/api/admin/panos/rl-p1?status=1',
    '/api/admin/tours',
    '/api/admin/tours/rl-t1',
  ])('429s GET %s with Retry-After, keyed by the owner', async (path) => {
    const read = limiter(false);
    const write = limiter(true);
    const r = await call(path, { headers: bearer }, { READ_LIMITER: read, WRITE_LIMITER: write });
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe(String(WRITE_RATE_PERIOD_SECONDS));
    expect(read.limit).toHaveBeenCalledWith({ key: SUB });
    expect(write.limit).not.toHaveBeenCalled();
  });

  it('checks the token first: an unauthenticated read is a 401 and spends nothing', async () => {
    const read = limiter(false);
    const r = await call('/api/admin/tours', {}, { READ_LIMITER: read });
    expect(r.status).toBe(401);
    expect(read.limit).not.toHaveBeenCalled();
  });

  it('leaves writes to the write limiter', async () => {
    const read = limiter(false);
    const r = await call(
      '/api/admin/tours',
      { method: 'POST', headers: bearer, body: JSON.stringify({ title: 'T', scenes: [] }) },
      { READ_LIMITER: read },
    );
    expect(r.status).toBe(201);
    expect(read.limit).not.toHaveBeenCalled();
  });
});

describe('Insights', () => {
  const sqlRows = (sql: string) => {
    if (sql.includes("blob1 = 'dwell'")) return [{ avg: 0, n: 0 }];
    return [];
  };
  const stubSql = () =>
    vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async (_input, init) => new Response(JSON.stringify({ data: sqlRows(String(init?.body)) })),
      );

  it('429s past its own per-owner limit, before any SQL call', async () => {
    await env.BUCKET.put(tourKey(SUB, 'ins-limited'), '{}');
    const spy = stubSql();
    const insights = limiter(false);
    const read = limiter(true);
    const r = await call(
      '/api/admin/tours/ins-limited/insights',
      { headers: bearer },
      { INSIGHTS_LIMITER: insights, READ_LIMITER: read },
    );
    expect(r.status).toBe(429);
    expect(insights.limit).toHaveBeenCalledWith({ key: SUB });
    expect(read.limit).toHaveBeenCalledWith({ key: SUB });
    expect(spy).not.toHaveBeenCalled();
  });

  it('reuses an answer per tour and days, and never for another owner', async () => {
    await env.BUCKET.put(tourKey(SUB, 'ins-cached'), '{}');
    const spy = stubSql();
    const first = await call('/api/admin/tours/ins-cached/insights?days=7', { headers: bearer });
    expect(first.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(4);
    // Made-up parameters don't skip the cache; the browser is still told not to store it.
    const again = await call('/api/admin/tours/ins-cached/insights?days=7&x=1', {
      headers: bearer,
    });
    expect(again.status).toBe(200);
    expect(again.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await again.json()).toEqual(await first.json());
    expect(spy).toHaveBeenCalledTimes(4);
    // Another window is another answer.
    expect(
      (await call('/api/admin/tours/ins-cached/insights?days=8', { headers: bearer })).status,
    ).toBe(200);
    expect(spy).toHaveBeenCalledTimes(8);
    // Someone who doesn't own the tour gets the 404, not the cached answer.
    setTestJwtVerifier(async (t) =>
      t === 'other'
        ? { sub: 'auth0|not-the-owner' }
        : t === 'good'
          ? { sub: SUB }
          : Promise.reject(new Error('bad')),
    );
    const theirs = await call('/api/admin/tours/ins-cached/insights?days=7', {
      headers: { Authorization: 'Bearer other' },
    });
    expect(theirs.status).toBe(404);
  });

  it('never caches a failure', async () => {
    await env.BUCKET.put(tourKey(SUB, 'ins-flaky'), '{}');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    expect((await call('/api/admin/tours/ins-flaky/insights', { headers: bearer })).status).toBe(
      502,
    );
    vi.restoreAllMocks();
    const spy = stubSql();
    expect((await call('/api/admin/tours/ins-flaky/insights', { headers: bearer })).status).toBe(
      200,
    );
    expect(spy).toHaveBeenCalledTimes(4);
  });
});

describe('operator routes: per-IP limit', () => {
  const IP = '203.0.113.9';

  it.each([OPERATOR_TAKEDOWN_PATH, OPERATOR_RESTORE_PATH])(
    '%s counts a wrong token against the client IP',
    async (path) => {
      const op = limiter(true);
      const r = await call(
        path,
        {
          method: 'POST',
          headers: { 'CF-Connecting-IP': IP, [OPERATOR_TOKEN_HEADER]: 'wrong' },
          body: '{}',
        },
        { OPERATOR_LIMITER: op },
      );
      expect(r.status).toBe(404);
      expect(op.limit).toHaveBeenCalledWith({ key: IP });
    },
  );

  it('429s past the limit even with the right token, doing nothing', async () => {
    await env.BUCKET.put(tourKey(SUB, 'op-limited'), '{}');
    const op = limiter(false);
    const write = limiter(true);
    const r = await call(
      OPERATOR_TAKEDOWN_PATH,
      {
        method: 'POST',
        headers: { 'CF-Connecting-IP': IP, [OPERATOR_TOKEN_HEADER]: 'test-operator-token' },
        body: JSON.stringify({ sub: SUB, tourId: 'op-limited', action: 'delete' }),
      },
      { OPERATOR_LIMITER: op, WRITE_LIMITER: write },
    );
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe(String(WRITE_RATE_PERIOD_SECONDS));
    expect(await env.BUCKET.head(tourKey(SUB, 'op-limited'))).not.toBeNull();
    expect(write.limit).not.toHaveBeenCalled();
  });
});

describe('write bodies are read up to a cap', () => {
  const tourCount = async () =>
    (await env.BUCKET.list({ prefix: userToursPrefix(SUB) })).objects.length;

  it('413s a chunked tour body past MAX_WRITE_BODY_BYTES, creating nothing', async () => {
    const before = await tourCount();
    const r = await call('/api/admin/tours', {
      method: 'POST',
      headers: bearer,
      body: chunked(Math.ceil(MAX_WRITE_BODY_BYTES / 1024) + 1, 1024),
      duplex: 'half',
    } as RequestInit);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'body too large' });
    expect(await tourCount()).toBe(before);
  });

  it('413s a Content-Length over the cap without reading the body', async () => {
    const pull = vi.fn();
    const r = await call('/api/admin/tours/any/visibility', {
      method: 'PATCH',
      headers: { ...bearer, 'content-length': String(MAX_WRITE_BODY_BYTES + 1) },
      body: new ReadableStream({ pull }, { highWaterMark: 0 }),
      duplex: 'half',
    } as RequestInit);
    expect(r.status).toBe(413);
    expect(pull).not.toHaveBeenCalled();
  });

  it('still answers a body that is not JSON with the route schema 400', async () => {
    const r = await call('/api/admin/tours', { method: 'POST', headers: bearer, body: '{nope' });
    expect(r.status).toBe(400);
  });

  it('413s a chunked scene config past MAX_CONFIG_BODY_BYTES', async () => {
    await env.BUCKET.put(originalKey(SUB, 'cfg-huge'), 'bytes');
    const mib = 1024 * 1024;
    const r = await call('/api/admin/panos/cfg-huge/config', {
      method: 'PUT',
      headers: { ...bearer, 'If-None-Match': '*' },
      body: chunked(MAX_CONFIG_BODY_BYTES / mib + 1, mib),
      duplex: 'half',
    } as RequestInit);
    expect(r.status).toBe(413);
  });

  // Every field at its schema cap, in 3-byte UTF-8: the largest config the editor could send.
  const maxConfig = (panoId: string) => {
    const ch = '漢';
    let translated = MAX_SCENE_TRANSLATION_CHARS;
    const hotspots = Array.from({ length: MAX_HOTSPOTS }, (_, i) => {
      const n = Math.min(translated, MAX_HOTSPOT_BODY_LENGTH);
      translated -= n;
      return {
        id: `h${i}`.padEnd(64, 'x'),
        type: 'link',
        yaw: 1.2345678901234567,
        pitch: 0.1234567890123456,
        title: ch.repeat(MAX_TITLE_LENGTH),
        body: ch.repeat(MAX_HOTSPOT_BODY_LENGTH),
        icon: 'a'.repeat(40),
        size: 2.5,
        media: {
          kind: 'link',
          url: `https://example.com/${'a'.repeat(MAX_MEDIA_URL_LENGTH - 20)}`,
        },
        targetPanoId: 'p'.repeat(MAX_ID_LENGTH),
        ...(n > 0 ? { i18n: { fr: { body: ch.repeat(n) } } } : {}),
      };
    });
    return {
      panoId,
      title: ch.repeat(MAX_TITLE_LENGTH),
      description: ch.repeat(MAX_SCENE_DESCRIPTION_LENGTH),
      initialView: { yaw: 1.1, pitch: 0.2, fov: 60 },
      north: 0.5,
      hotspots,
    };
  };

  it('takes the largest config the schema allows', async () => {
    await env.BUCKET.put(originalKey(SUB, 'cfg-max'), 'bytes');
    const config = maxConfig('cfg-max');
    expect(SceneConfigSchema.safeParse(config).success).toBe(true);
    const body = JSON.stringify(config);
    // Well past the cap for every other write, and with headroom under its own.
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(12 * 1024 * 1024);
    const r = await call('/api/admin/panos/cfg-max/config', {
      method: 'PUT',
      headers: { ...bearer, 'If-None-Match': '*' },
      body,
    });
    expect(r.status).toBe(200);
  });
});

describe('route ids are at most MAX_ID_LENGTH characters', () => {
  const long = 'a'.repeat(MAX_ID_LENGTH + 1);
  const huge = 'a'.repeat(2000);

  it.each([
    ['GET', '/api/admin/panos/:long', `/api/admin/panos/${long}`],
    ['GET', '/api/admin/panos/:huge?status=1', `/api/admin/panos/${huge}?status=1`],
    ['DELETE', '/api/admin/panos/:huge', `/api/admin/panos/${huge}`],
    ['GET', '/api/admin/tours/:huge', `/api/admin/tours/${huge}`],
    ['DELETE', '/api/admin/tours/:huge', `/api/admin/tours/${huge}`],
    ['POST', '/api/admin/tours/:huge/publish', `/api/admin/tours/${huge}/publish`],
    ['PUT', '/api/admin/tours/:huge/slug', `/api/admin/tours/${huge}/slug`],
    ['PATCH', '/api/admin/tours/:huge/visibility', `/api/admin/tours/${huge}/visibility`],
    ['DELETE', '/api/admin/tours/:huge/publish', `/api/admin/tours/${huge}/publish`],
    ['GET', '/api/admin/tours/:huge/insights', `/api/admin/tours/${huge}/insights`],
    ['GET', '/api/admin/tours?cursor=:long', `/api/admin/tours?cursor=${long}`],
    ['GET', '/api/admin/panos?cursor=:long', `/api/admin/panos?cursor=${long}`],
  ])('400s %s %s', async (method, _label, path) => {
    const r = await call(path, { method, headers: bearer });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/at most 64 characters/);
  });

  it('takes an id of exactly MAX_ID_LENGTH', async () => {
    const r = await call(`/api/admin/tours/${'a'.repeat(MAX_ID_LENGTH)}`, { headers: bearer });
    expect(r.status).toBe(404);
  });
});
