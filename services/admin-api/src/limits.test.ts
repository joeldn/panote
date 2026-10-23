// admin-api's abuse limits: the per-owner write rate limit, the per-owner tour
// cap, and configs only for panos the caller uploaded.
import {
  configKey,
  deletingKey,
  MAX_TOURS_PER_OWNER,
  originalKey,
  publishKey,
  tourKey,
  userToursPrefix,
} from '@internal/contracts';
import { getJson, putJson } from '@internal/worker-kit/r2-binding';
import { parseJsonc, setTestJwtVerifier } from '@internal/worker-kit/testing';
import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import wrangler from '../wrangler.jsonc?raw';
import worker, { WRITE_RATE_PERIOD_SECONDS } from './index.js';
import { countTours } from './lists.js';

const LIMITED_SUB = 'auth0|limited';
const CAPPED_SUB = 'auth0|capped';
const CONFIG_SUB = 'auth0|config-owner';

beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t === 'limited') return { sub: LIMITED_SUB };
    if (t === 'capped') return { sub: CAPPED_SUB };
    if (t === 'config') return { sub: CONFIG_SUB };
    return Promise.reject(new Error('bad'));
  });
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// Calls the Worker directly, so a test can swap the limiter binding.
const call = async (
  path: string,
  init: RequestInit & { headers?: Record<string, string> },
  overrides: Partial<Env>,
) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://x${path}`, init),
    { ...env, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
};

describe('per-owner write rate limit', () => {
  it('429s a write with Retry-After, keyed by the owner, before it writes anything', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const before = await env.BUCKET.list({ prefix: userToursPrefix(LIMITED_SUB) });
    const r = await call(
      '/api/admin/tours',
      {
        method: 'POST',
        headers: bearer('limited'),
        body: JSON.stringify({ title: 'T', scenes: [] }),
      },
      { WRITE_LIMITER: { limit } },
    );
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe(String(WRITE_RATE_PERIOD_SECONDS));
    expect(await r.json()).toEqual({ error: 'rate limited' });
    expect(limit).toHaveBeenCalledWith({ key: LIMITED_SUB });
    const after = await env.BUCKET.list({ prefix: userToursPrefix(LIMITED_SUB) });
    expect(after.objects.length).toBe(before.objects.length);
  });

  it.each([
    ['PUT', '/api/admin/panos/rl-p1/config'],
    ['PUT', '/api/admin/tours/rl-t1'],
    ['PATCH', '/api/admin/tours/rl-t1/visibility'],
    ['DELETE', '/api/admin/panos/rl-p1'],
    ['DELETE', '/api/admin/account'],
  ])('limits %s %s too', async (method, path) => {
    const limit = vi.fn(async () => ({ success: false }));
    const r = await call(
      path,
      { method, headers: bearer('limited'), body: '{}' },
      { WRITE_LIMITER: { limit } },
    );
    expect(r.status).toBe(429);
  });

  it('never limits a read, an unauthenticated request or the operator route', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const limiter = { WRITE_LIMITER: { limit } };
    expect((await call('/api/admin/tours', { headers: bearer('limited') }, limiter)).status).toBe(
      200,
    );
    expect((await call('/api/admin/tours', { method: 'POST', body: '{}' }, limiter)).status).toBe(
      401,
    );
    // A wrong operator token is a plain 404, whatever the limiter says.
    const op = await call('/api/admin/operator/takedown', { method: 'POST', body: '{}' }, limiter);
    expect(op.status).toBe(404);
    expect(limit).not.toHaveBeenCalled();
  });

  it('lets a write through while the owner is under the limit', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const r = await call(
      '/api/admin/tours',
      {
        method: 'POST',
        headers: bearer('limited'),
        body: JSON.stringify({ title: 'T', scenes: [] }),
      },
      { WRITE_LIMITER: { limit } },
    );
    expect(r.status).toBe(201);
  });

  it.each(['dev', 'production'])(
    '%s: every limiter period is WRITE_RATE_PERIOD_SECONDS',
    (name) => {
      type Config = {
        env: Record<string, { ratelimits?: { name: string; simple: { period: number } }[] }>;
      };
      const limiters = (parseJsonc(wrangler) as Config).env[name]?.ratelimits ?? [];
      expect(limiters.map((l) => [l.name, l.simple.period])).toEqual([
        ['WRITE_LIMITER', WRITE_RATE_PERIOD_SECONDS],
        ['READ_LIMITER', WRITE_RATE_PERIOD_SECONDS],
        ['INSIGHTS_LIMITER', WRITE_RATE_PERIOD_SECONDS],
        ['OPERATOR_LIMITER', WRITE_RATE_PERIOD_SECONDS],
      ]);
    },
  );
});

describe(`at most ${MAX_TOURS_PER_OWNER} tours per owner`, () => {
  const create = (title: string) =>
    SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: bearer('capped'),
      body: JSON.stringify({ title, scenes: [] }),
    });

  it('refuses the next tour with 403 tour limit reached, and allows one again after a delete', async () => {
    // Seeded straight into R2: 200 POSTs would be slow. One publish.json-only
    // folder (a half-deleted tour) must not count.
    for (let i = 0; i < MAX_TOURS_PER_OWNER - 1; i += 1) {
      await putJson(env.BUCKET, tourKey(CAPPED_SUB, `cap-t${i}`), {
        tourId: `cap-t${i}`,
        title: 'T',
        scenes: [],
      });
    }
    await env.BUCKET.put(publishKey(CAPPED_SUB, 'cap-orphan'), '{}');
    expect((await create('Last one')).status).toBe(201);

    const refused = await create('One too many');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'tour limit reached' });
    const list = await env.BUCKET.list({ prefix: userToursPrefix(CAPPED_SUB) });
    expect(list.objects.filter((o) => o.key.endsWith('/tour.json'))).toHaveLength(
      MAX_TOURS_PER_OWNER,
    );

    const del = await SELF.fetch('https://x/api/admin/tours/cap-t0', {
      method: 'DELETE',
      headers: bearer('capped'),
    });
    expect(del.status).toBe(204);
    expect((await create('Room again')).status).toBe(201);
  });
});

describe('countTours', () => {
  // A stub listing: pages of keys under the owner's tours/ prefix, each truncated
  // but the last, so the cursor loop is what's under test.
  const stubBucket = (pages: string[][]) => {
    const list = vi.fn(async (opts: R2ListOptions) => {
      const i = opts.cursor ? Number(opts.cursor) : 0;
      const last = i === pages.length - 1;
      return {
        objects: (pages[i] ?? []).map((key) => ({ key })),
        delimitedPrefixes: [],
        ...(last ? { truncated: false } : { truncated: true, cursor: String(i + 1) }),
      };
    });
    return { bucket: { list } as unknown as R2Bucket, list };
  };
  const prefix = userToursPrefix(CAPPED_SUB);

  it('follows the cursor across truncated pages and counts only tour.json', async () => {
    const { bucket, list } = stubBucket([
      [`${prefix}a/tour.json`, `${prefix}a/publish.json`],
      [`${prefix}b/publish.json`],
      [`${prefix}c/tour.json`, `${prefix}d/tour.json`],
    ]);
    expect(await countTours(bucket, CAPPED_SUB, 10)).toBe(3);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls.map(([o]) => o.cursor)).toEqual([undefined, '1', '2']);
    expect(list.mock.calls.every(([o]) => o.prefix === prefix)).toBe(true);
  });

  it('stops listing once it reaches stopAt', async () => {
    const { bucket, list } = stubBucket([
      [`${prefix}a/tour.json`, `${prefix}b/tour.json`],
      [`${prefix}c/tour.json`],
    ]);
    expect(await countTours(bucket, CAPPED_SUB, 2)).toBe(2);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('config PUT needs an uploaded pano', () => {
  const putConfig = (panoId: string, headers: Record<string, string>, title = 'Hall') =>
    SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...bearer('config'), ...headers },
      body: JSON.stringify({ title, hotspots: [] }),
    });

  it('404s a config for a panoId with no original and no config, storing nothing', async () => {
    for (const headers of [{ 'If-None-Match': '*' }, { 'If-Match': '*' }]) {
      const r = await putConfig('cfg-never-uploaded', headers);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'pano not found' });
    }
    expect(await env.BUCKET.head(configKey(CONFIG_SUB, 'cfg-never-uploaded'))).toBeNull();
  });

  it("404s a config for another owner's upload", async () => {
    await env.BUCKET.put(originalKey('auth0|someone-else', 'cfg-theirs'), 'bytes');
    expect((await putConfig('cfg-theirs', { 'If-None-Match': '*' })).status).toBe(404);
  });

  it('creates the config once the original exists (the upload flow)', async () => {
    await env.BUCKET.put(originalKey(CONFIG_SUB, 'cfg-uploaded'), 'bytes');
    expect((await putConfig('cfg-uploaded', { 'If-None-Match': '*' })).status).toBe(200);
    expect((await putConfig('cfg-uploaded', { 'If-None-Match': '*' })).status).toBe(412);
  });

  it('still updates a legacy config-only pano, but If-Match: * only overwrites the config just read', async () => {
    const seeded = await putJson(env.BUCKET, configKey(CONFIG_SUB, 'cfg-legacy'), {
      panoId: 'cfg-legacy',
      title: 'Old',
      hotspots: [],
    });
    expect(seeded.ok).toBe(true);
    const etag = seeded.ok ? seeded.etag : '';
    const byEtag = await putConfig('cfg-legacy', { 'If-Match': `"${etag}"` }, 'New');
    expect(byEtag.status).toBe(200);
    expect((await putConfig('cfg-legacy', { 'If-Match': '*' }, 'Newer')).status).toBe(200);
    const stored = await getJson<{ title: string }>(
      env.BUCKET,
      configKey(CONFIG_SUB, 'cfg-legacy'),
    );
    expect(stored?.value.title).toBe('Newer');
  });

  it('a delete tombstone still answers 409 first, even with no original left', async () => {
    await env.BUCKET.put(deletingKey(CONFIG_SUB, 'cfg-deleting'), '');
    const r = await putConfig('cfg-deleting', { 'If-None-Match': '*' });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'pano is being deleted' });
  });
});
