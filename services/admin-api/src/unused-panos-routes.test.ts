import {
  configKey,
  deletingKey,
  manifestKey,
  originalKey,
  previewKey,
  tileFailedKey,
  tileVersionPrefix,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { RECENT_UPLOAD_MS } from './delete-owned-pano.js';

const MY_SUB = 'auth0|unused-me';
const OTHER_SUB = 'auth0|unused-other';
const auth = { Authorization: 'Bearer good' };
const authOther = { Authorization: 'Bearer good-other' };

beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t === 'good') return { sub: MY_SUB };
    if (t === 'good-other') return { sub: OTHER_SUB };
    return Promise.reject(new Error('bad'));
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// R2 stamps `uploaded` with the real clock; moving the worker's clock past
// the recent-upload window makes every pano seeded so far count as old.
const pastRecentWindow = () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 2 * RECENT_UPLOAD_MS);
};

/** A tiled pano: original, config, a manifest whose version matches the
 * original (so tiling is `ready`), a tile and the preview. */
const readyPano = async (sub: string, panoId: string) => {
  const put = await env.BUCKET.put(originalKey(sub, panoId), 'bytes');
  const version = `t1-${put!.etag}`;
  await env.BUCKET.put(configKey(sub, panoId), JSON.stringify({ panoId, title: panoId }));
  await env.BUCKET.put(
    manifestKey(panoId),
    JSON.stringify({ pano: panoId, version, format: 'webp', tileSize: 512, preview: true }),
  );
  await env.BUCKET.put(`${tileVersionPrefix(panoId, version)}0/pz/0-0.webp`, 'tile');
  await env.BUCKET.put(previewKey(panoId, version), 'preview');
  return version;
};

const createTour = async (panoIds: string[], headers = auth): Promise<string> => {
  const res = await SELF.fetch('https://x/api/admin/tours', {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'T', scenes: panoIds.map((panoId) => ({ panoId })) }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { tourId: string }).tourId;
};

const del = (panoId: string, headers = auth) =>
  SELF.fetch(`https://x/api/admin/panos/${panoId}`, { method: 'DELETE', headers });

describe('GET /api/admin/panos?include=references', () => {
  it('marks each pano referenced by any of the caller’s tours, and only with the flag', async () => {
    await readyPano(MY_SUB, 'refs-used');
    await readyPano(MY_SUB, 'refs-unused');
    await createTour([]);
    await createTour(['refs-used']);
    // Another owner's tour using my panoId never counts.
    await createTour(['refs-unused'], authOther);

    const withRefs = await SELF.fetch('https://x/api/admin/panos?include=references', {
      headers: auth,
    });
    const { panos } = (await withRefs.json()) as {
      panos: Array<{ panoId: string; referenced?: boolean }>;
    };
    expect(panos.find((p) => p.panoId === 'refs-used')?.referenced).toBe(true);
    expect(panos.find((p) => p.panoId === 'refs-unused')?.referenced).toBe(false);

    const plain = await SELF.fetch('https://x/api/admin/panos', { headers: auth });
    const body = (await plain.json()) as { panos: Array<Record<string, unknown>> };
    expect(body.panos.every((p) => !('referenced' in p))).toBe(true);
  });
});

describe('DELETE /api/admin/panos/:panoId guards', () => {
  it('deletes an unused, tiled, old pano: every object kind goes', async () => {
    const version = await readyPano(MY_SUB, 'del-ok');
    await env.BUCKET.put(tileFailedKey(MY_SUB, 'del-ok'), '');
    pastRecentWindow();

    const res = await del('del-ok');

    expect(res.status).toBe(204);
    const left = await env.BUCKET.list({ prefix: 'panos/' });
    expect(left.objects.filter((o) => o.key.includes('/del-ok/'))).toEqual([]);
    expect(await env.BUCKET.head(manifestKey('del-ok'))).toBeNull();
    expect(await env.BUCKET.head(previewKey('del-ok', version))).toBeNull();
    expect(await env.BUCKET.list({ prefix: 'tiles/del-ok/' })).toMatchObject({ objects: [] });
  });

  it('409s a pano a tour uses, with the in-use error, and keeps everything', async () => {
    await readyPano(MY_SUB, 'del-used');
    await createTour(['del-used']);
    pastRecentWindow();

    const res = await del('del-used');

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'pano is in use' });
    expect(await env.BUCKET.head(originalKey(MY_SUB, 'del-used'))).not.toBeNull();
    expect(await env.BUCKET.head(manifestKey('del-used'))).not.toBeNull();
    expect(await env.BUCKET.head(deletingKey(MY_SUB, 'del-used'))).toBeNull();
  });

  it('409s a pano still tiling, and one that finished less than an hour ago', async () => {
    await env.BUCKET.put(originalKey(MY_SUB, 'del-tiling'), 'bytes');
    await readyPano(MY_SUB, 'del-fresh');

    const tiling = await del('del-tiling');
    expect(tiling.status).toBe(409);
    expect(await tiling.json()).toEqual({ error: 'pano is processing' });

    const fresh = await del('del-fresh');
    expect(fresh.status).toBe(409);
    expect(await fresh.json()).toEqual({ error: 'pano was uploaded recently' });

    expect(await env.BUCKET.head(originalKey(MY_SUB, 'del-tiling'))).not.toBeNull();
    expect(await env.BUCKET.head(originalKey(MY_SUB, 'del-fresh'))).not.toBeNull();
  });

  it("404s another owner's pano and leaves all of it in place", async () => {
    await readyPano(OTHER_SUB, 'del-theirs');
    pastRecentWindow();

    const res = await del('del-theirs');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(await env.BUCKET.head(originalKey(OTHER_SUB, 'del-theirs'))).not.toBeNull();
    expect(await env.BUCKET.head(manifestKey('del-theirs'))).not.toBeNull();
    // The owner can still delete it.
    expect((await del('del-theirs', authOther)).status).toBe(204);
  });

  it('404s a repeat delete', async () => {
    await readyPano(MY_SUB, 'del-twice');
    pastRecentWindow();
    expect((await del('del-twice')).status).toBe(204);
    expect((await del('del-twice')).status).toBe(404);
  });
});
