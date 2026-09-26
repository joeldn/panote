import {
  configKey,
  deletingKey,
  encodeId,
  manifestKey,
  MAX_TOUR_SCENES,
  originalKey,
  tileFailedKey,
  tileVersionPrefix,
  tourKey,
} from '@internal/contracts';
import { getJson } from '@internal/worker-kit/r2-binding';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

const MY_SUB = 'auth0|me';
const OTHER_SUB = 'auth0|other';

// Test seam: authenticate() reads globalThis.__verifyJwt when it is set.
// Installed here through setTestJwtVerifier - the only sanctioned way to reach
// it (see the port spec section 0.8). Never touch globalThis directly.
// 'good' and 'good-other' resolve to two distinct users so cross-tenant
// isolation can be asserted; anything else rejects.
beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t === 'good') return { sub: 'auth0|me' };
    if (t === 'good-other') return { sub: 'auth0|other' };
    return Promise.reject(new Error('bad'));
  });
});

const auth = { headers: { Authorization: 'Bearer good' } };
const authOther = { headers: { Authorization: 'Bearer good-other' } };

// Every case below uses its own panoId/tourId namespace (port spec section 0.7):
// storage is shared between it() cases in this file (unlike between files), so
// each case creates whatever it asserts on rather than relying on another
// case's fixtures.
describe('admin panos routes', () => {
  it('rejects an unauthenticated write', async () => {
    const r = await SELF.fetch('https://x/api/admin/panos/unauth-p1/config', {
      method: 'PUT',
      body: '{}',
    });
    expect(r.status).toBe(401);
  });

  it('rejects an unauthenticated list', async () => {
    const r = await SELF.fetch('https://x/api/admin/panos');
    expect(r.status).toBe(401);
  });

  it('rejects an unauthenticated delete', async () => {
    const r = await SELF.fetch('https://x/api/admin/panos/unauth-delete-p1', {
      method: 'DELETE',
    });
    expect(r.status).toBe(401);
  });

  it("does not list another user's panos", async () => {
    const mine = 'cross-tenant-mine-p1';
    const theirs = 'cross-tenant-theirs-p1';
    await SELF.fetch(`https://x/api/admin/panos/${mine}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId: mine, title: 'Mine', hotspots: [] }),
    });
    await SELF.fetch(`https://x/api/admin/panos/${theirs}/config`, {
      method: 'PUT',
      headers: { ...authOther.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId: theirs, title: 'Theirs', hotspots: [] }),
    });
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const ids = ((await list.json()) as { panoIds: string[] }).panoIds;
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it('creates then lists a scene config', async () => {
    const panoId = 'create-list-p1';
    const body = JSON.stringify({ panoId, title: 'Hall', hotspots: [] });
    const put = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body,
    });
    expect(put.status).toBe(200);
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    expect(((await list.json()) as { panoIds: string[] }).panoIds).toContain(panoId);
  });

  it('412s on a stale conditional update', async () => {
    const panoId = 'stale-p1';
    // Seed the object first so there is an etag to be stale against.
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Seed', hotspots: [] }),
    });
    const stale = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '"nonsense"' },
      body: JSON.stringify({ panoId, title: 'X', hotspots: [] }),
    });
    expect(stale.status).toBe(412);
  });

  it('a bare quote in If-Match 412s (guaranteed mismatch), not a 500', async () => {
    const panoId = 'bad-quote-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Seed', hotspots: [] }),
    });
    const r = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '"' },
      body: JSON.stringify({ panoId, title: 'X', hotspots: [] }),
    });
    expect(r.status).toBe(412);
    expect(await r.json()).toEqual({ error: 'conflict' });
    // No put was attempted: the seeded config is untouched.
    const stored = await getJson<{ title: string }>(env.BUCKET, configKey(MY_SUB, panoId));
    expect(stored?.value.title).toBe('Seed');
  });

  it('an "x*y" If-Match 412s rather than doing an unconditional overwrite', async () => {
    const panoId = 'star-in-tag-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Seed', hotspots: [] }),
    });
    const r = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': 'x*y' },
      body: JSON.stringify({ panoId, title: 'X', hotspots: [] }),
    });
    expect(r.status).toBe(412);
  });

  it('400s a multi-tag If-Match', async () => {
    const panoId = 'multi-tag-if-match-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Seed', hotspots: [] }),
    });
    const r = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '"a", "b"' },
      body: JSON.stringify({ panoId, title: 'X', hotspots: [] }),
    });
    expect(r.status).toBe(400);
  });

  it('428s when a mutating update omits If-Match', async () => {
    const panoId = 'missing-if-match-p1';
    const r = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers },
      body: JSON.stringify({ panoId, title: 'X', hotspots: [] }),
    });
    expect(r.status).toBe(428);
  });

  it('still 428s with a missing If-Match even while a delete tombstone exists', async () => {
    const panoId = 'missing-if-match-tombstone-p1';
    await env.BUCKET.put(deletingKey(MY_SUB, panoId), '');
    const r = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers },
      body: JSON.stringify({ panoId, title: 'X', hotspots: [] }),
    });
    expect(r.status).toBe(428);
  });

  it('400s on a body that fails SceneConfigSchema', async () => {
    const panoId = 'invalid-body-p1';
    const r = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      // Missing the required `title` field.
      body: JSON.stringify({ panoId }),
    });
    expect(r.status).toBe(400);
  });

  it('deletes a pano and it no longer lists, without touching a sibling', async () => {
    const panoId = 'delete-p1';
    const siblingId = 'delete-p1-sibling';
    // A handler that wiped the whole user prefix instead of just panoId would
    // still pass a test that only checks the deleted id is gone - create a
    // sibling first so a too-broad delete has something to break.
    await SELF.fetch(`https://x/api/admin/panos/${siblingId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId: siblingId, title: 'Sibling', hotspots: [] }),
    });
    await env.BUCKET.put(originalKey(MY_SUB, siblingId), 'sibling original bytes');
    await env.BUCKET.put(tileVersionPrefix(siblingId, 't1-sib') + '0/px/0-0.webp', 'sib tile');

    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Hall', hotspots: [] }),
    });
    // Seed the original plus two tile versions and the manifest so the
    // DELETE has real tile output to prove it actually removes.
    await env.BUCKET.put(originalKey(MY_SUB, panoId), 'original bytes');
    await env.BUCKET.put(tileVersionPrefix(panoId, 't1-abc') + '0/px/0-0.webp', 'tile v1');
    await env.BUCKET.put(tileVersionPrefix(panoId, 't1-def') + '0/px/0-0.webp', 'tile v2');
    await env.BUCKET.put(manifestKey(panoId), JSON.stringify({ pano: panoId }));

    const del = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, {
      method: 'DELETE',
      headers: auth.headers,
    });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe('');

    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const ids = ((await list.json()) as { panoIds: string[] }).panoIds;
    expect(ids).not.toContain(panoId);
    expect(ids).toContain(siblingId);

    expect(await env.BUCKET.get(originalKey(MY_SUB, panoId))).toBeNull();
    expect(await env.BUCKET.get(configKey(MY_SUB, panoId))).toBeNull();
    expect(await env.BUCKET.get(manifestKey(panoId))).toBeNull();
    expect(await env.BUCKET.get(tileVersionPrefix(panoId, 't1-abc') + '0/px/0-0.webp')).toBeNull();
    expect(await env.BUCKET.get(tileVersionPrefix(panoId, 't1-def') + '0/px/0-0.webp')).toBeNull();

    // The sibling pano is completely untouched.
    expect(await env.BUCKET.get(originalKey(MY_SUB, siblingId))).not.toBeNull();
    expect(await env.BUCKET.get(configKey(MY_SUB, siblingId))).not.toBeNull();
    expect(
      await env.BUCKET.get(tileVersionPrefix(siblingId, 't1-sib') + '0/px/0-0.webp'),
    ).not.toBeNull();
  });

  it('deletes a config-only pano (no original ever uploaded) and it no longer lists', async () => {
    const panoId = 'delete-no-original-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'No original', hotspots: [] }),
    });

    const del = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, {
      method: 'DELETE',
      headers: auth.headers,
    });
    expect(del.status).toBe(204);

    expect(await env.BUCKET.get(configKey(MY_SUB, panoId))).toBeNull();
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    expect(((await list.json()) as { panoIds: string[] }).panoIds).not.toContain(panoId);
  });

  it("204s a user's DELETE of another user's panoId, whose config they merely PUT, removing only their own config and leaving the owner's original and tiles untouched", async () => {
    const panoId = 'delete-cross-tenant-p1';
    // User A owns this panoId: uploaded the original and has tiled output.
    await env.BUCKET.put(originalKey(MY_SUB, panoId), 'a original bytes');
    await env.BUCKET.put(tileVersionPrefix(panoId, 't1-abc') + '0/px/0-0.webp', 'a tile');

    // User B PUTs a config under the same panoId (allowed - config is keyed
    // by (sub, panoId), not exclusive) but never uploaded an original there.
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...authOther.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'B config', hotspots: [] }),
    });

    const del = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, {
      method: 'DELETE',
      headers: authOther.headers,
    });
    expect(del.status).toBe(204);

    // B's own config (the only thing B ever owned here) is gone.
    expect(await env.BUCKET.get(configKey(OTHER_SUB, panoId))).toBeNull();
    // A's original and tiles survive untouched.
    expect(await env.BUCKET.get(originalKey(MY_SUB, panoId))).not.toBeNull();
    expect(
      await env.BUCKET.get(tileVersionPrefix(panoId, 't1-abc') + '0/px/0-0.webp'),
    ).not.toBeNull();
  });

  it('a repeat DELETE after a successful delete is still 204 (idempotent)', async () => {
    const panoId = 'delete-repeat-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Repeat', hotspots: [] }),
    });
    await env.BUCKET.put(originalKey(MY_SUB, panoId), 'original bytes');

    const first = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, {
      method: 'DELETE',
      headers: auth.headers,
    });
    expect(first.status).toBe(204);

    const second = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, {
      method: 'DELETE',
      headers: auth.headers,
    });
    expect(second.status).toBe(204);
  });

  it('400s a panoId containing "|" or a space (outside the URL-unreserved charset)', async () => {
    // panoId is stored raw in the R2 key (packages/contracts/src/keys.ts),
    // so it must be rejected up front rather than encoded after the fact.
    const panoId = 'probe pano|1';
    const put = await SELF.fetch(`https://x/api/admin/panos/${encodeURIComponent(panoId)}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Probe', hotspots: [] }),
    });
    expect(put.status).toBe(400);
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    expect(((await list.json()) as { panoIds: string[] }).panoIds).not.toContain(panoId);
  });

  it('400s a panoId containing "/"', async () => {
    // Unvalidated, "/" would add an extra key segment instead of being part
    // of the id.
    const panoId = 'slash/probe/1';
    const put = await SELF.fetch(`https://x/api/admin/panos/${encodeURIComponent(panoId)}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Slash probe', hotspots: [] }),
    });
    expect(put.status).toBe(400);
  });

  it('round-trips a panoId containing "_" and "-" (the full URL-unreserved charset) through create and list', async () => {
    const panoId = 'Valid_Pano-Id-123';
    const put = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Valid', hotspots: [] }),
    });
    expect(put.status).toBe(200);
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    expect(((await list.json()) as { panoIds: string[] }).panoIds).toContain(panoId);
  });

  it('400s DELETE with a panoId outside the URL-unreserved charset', async () => {
    // DELETE has no body schema, so the route validates the URL param
    // directly instead of relying on panoPrefix() to throw a 500.
    const r = await SELF.fetch(`https://x/api/admin/panos/${encodeURIComponent('bad/id')}`, {
      method: 'DELETE',
      headers: auth.headers,
    });
    expect(r.status).toBe(400);
  });
});

describe('admin tours routes', () => {
  it('creates then updates a tour', async () => {
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'My Tour', scenes: [] }),
    });
    expect(create.status).toBe(201);
    const { tourId } = (await create.json()) as { tourId: string };
    expect(typeof tourId).toBe('string');

    const update = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ title: 'My Tour Updated', scenes: [] }),
    });
    expect(update.status).toBe(200);
  });

  it('rejects an unauthenticated tour create', async () => {
    const r = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      body: JSON.stringify({ title: 'Nope', scenes: [] }),
    });
    expect(r.status).toBe(401);
  });

  it('rejects an unauthenticated tour update', async () => {
    const r = await SELF.fetch('https://x/api/admin/tours/unauth-tour-t1', {
      method: 'PUT',
      body: '{}',
    });
    expect(r.status).toBe(401);
  });

  it('still 428s a tour update with a missing If-Match even for a never-created tourId', async () => {
    const r = await SELF.fetch('https://x/api/admin/tours/missing-if-match-t1', {
      method: 'PUT',
      headers: auth.headers,
      body: JSON.stringify({ title: 'X', scenes: [] }),
    });
    expect(r.status).toBe(428);
  });

  it('400s on a tour body that fails TourDocSchema', async () => {
    const r = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      // Missing the required `title` field.
      body: '{}',
    });
    expect(r.status).toBe(400);
  });

  it('400s a PUT tourId outside the URL-unreserved charset', async () => {
    // tourId is stored raw in tourKey() for the same reason as panoId, so
    // TourDocSchema rejects it here before it reaches tourKey().
    const tourId = 'bad/tour|id';
    const r = await SELF.fetch(`https://x/api/admin/tours/${encodeURIComponent(tourId)}`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ title: 'X', scenes: [] }),
    });
    expect(r.status).toBe(400);
  });

  it('400s a tour body with more scenes than MAX_TOUR_SCENES', async () => {
    const scenes = Array.from({ length: MAX_TOUR_SCENES + 1 }, (_, i) => ({
      panoId: `cap-scene-${i}`,
    }));
    const r = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Too Many Scenes', scenes }),
    });
    expect(r.status).toBe(400);
  });

  it('accepts a tour body with exactly MAX_TOUR_SCENES scenes', async () => {
    const scenes = Array.from({ length: MAX_TOUR_SCENES }, (_, i) => ({
      panoId: `at-cap-scene-${i}`,
    }));
    const r = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'At Cap', scenes }),
    });
    expect(r.status).toBe(201);
  });

  it('stores two tours under independent keys', async () => {
    // There is no GET route for tours in this wave, and probing isolation
    // purely through PUT's conditional semantics is a dead end: PUT always
    // targets tourKey(sub, :tourId) and unconditionally creates that key if
    // absent, which silently "heals" a collision introduced by POST before
    // any HTTP-visible symptom appears. Read the R2 objects directly instead
    // (the same env.BUCKET/getJson pattern r2-binding.test.ts uses) to prove
    // each created tour actually landed under its own key with its own body,
    // rather than colliding onto tourKey(sub, 'fixed') for every tourId.
    const createA = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Tour A', scenes: [] }),
    });
    const { tourId: tourIdA } = (await createA.json()) as { tourId: string };

    const createB = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Tour B', scenes: [] }),
    });
    const { tourId: tourIdB } = (await createB.json()) as { tourId: string };
    expect(tourIdA).not.toBe(tourIdB);

    const storedA = await getJson<{ title: string }>(env.BUCKET, tourKey('auth0|me', tourIdA));
    const storedB = await getJson<{ title: string }>(env.BUCKET, tourKey('auth0|me', tourIdB));
    expect(storedA?.value.title).toBe('Tour A');
    expect(storedB?.value.title).toBe('Tour B');
  });
});

describe('GET /api/admin/panos/:panoId', () => {
  it('reads its own config with a quoted ETag header matching the PUT-returned etag', async () => {
    const panoId = 'get-p1';
    const put = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Hall', hotspots: [] }),
    });
    const { etag: putEtag } = (await put.json()) as { etag: string };

    const get = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, auth);
    expect(get.status).toBe(200);
    expect(get.headers.get('ETag')).toBe(`"${putEtag}"`);
    expect(get.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await get.json()) as { config: { title: string }; etag: string };
    expect(body.config.title).toBe('Hall');
    expect(body.etag).toBe(putEtag);
  });

  it('304s on a matching If-None-Match and 200s on a stale one', async () => {
    const panoId = 'get-etag-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Hall', hotspots: [] }),
    });
    const get = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, auth);
    const etag = get.headers.get('ETag');
    expect(etag).not.toBeNull();

    const notModified = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, {
      headers: { ...auth.headers, 'If-None-Match': etag ?? '' },
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe('');

    const stale = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, {
      headers: { ...auth.headers, 'If-None-Match': '"nonsense"' },
    });
    expect(stale.status).toBe(200);
  });

  it('304s on a weak (W/) etag and on a comma-separated list containing it', async () => {
    const panoId = 'get-weak-etag-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Hall', hotspots: [] }),
    });
    const get = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, auth);
    const etag = get.headers.get('ETag');

    const weak = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, {
      headers: { ...auth.headers, 'If-None-Match': `W/${etag}` },
    });
    expect(weak.status).toBe(304);
    expect(weak.headers.get('ETag')).toBe(etag);

    const list = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, {
      headers: { ...auth.headers, 'If-None-Match': `"other-tag", ${etag}` },
    });
    expect(list.status).toBe(304);
  });

  it('a bare quote in If-None-Match is treated as no match (200), not a 500', async () => {
    const panoId = 'get-bad-quote-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Hall', hotspots: [] }),
    });
    const r = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, {
      headers: { ...auth.headers, 'If-None-Match': '"' },
    });
    expect(r.status).toBe(200);
  });

  it('an "x*y" If-None-Match is a literal mismatching tag, not a wildcard match', async () => {
    const panoId = 'get-star-in-tag-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Hall', hotspots: [] }),
    });
    const r = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, {
      headers: { ...auth.headers, 'If-None-Match': 'x*y' },
    });
    expect(r.status).toBe(200);
  });

  it('round-trips a GET etag into a following PUT (If-Match) that succeeds', async () => {
    const panoId = 'get-roundtrip-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'V1', hotspots: [] }),
    });
    const get = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, auth);
    const { etag } = (await get.json()) as { etag: string };

    const update = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': etag },
      body: JSON.stringify({ panoId, title: 'V2', hotspots: [] }),
    });
    expect(update.status).toBe(200);

    // The etag from the GET before this update is now stale.
    const stalePut = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': etag },
      body: JSON.stringify({ panoId, title: 'V3', hotspots: [] }),
    });
    expect(stalePut.status).toBe(412);
  });

  it("404s a cross-owner GET instead of exposing the other owner's pano", async () => {
    const panoId = 'get-cross-tenant-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...authOther.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Theirs', hotspots: [] }),
    });
    const get = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, auth);
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({
      error: 'config not found',
      deleting: false,
      hasOriginal: false,
    });
  });

  it('404s with {deleting: true} while a delete tombstone exists', async () => {
    const panoId = 'get-tombstone-p1';
    await env.BUCKET.put(deletingKey(MY_SUB, panoId), '');
    const get = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, auth);
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({
      error: 'config not found',
      deleting: true,
      hasOriginal: false,
    });
  });

  it('404s with {hasOriginal: true} for an uploaded original whose config was never written', async () => {
    const panoId = 'get-original-only-p1';
    await env.BUCKET.put(originalKey(MY_SUB, panoId), 'original bytes');
    const get = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, auth);
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({
      error: 'config not found',
      deleting: false,
      hasOriginal: true,
    });
  });

  it('404s a panoId with no config, no original and no tombstone, still no-store', async () => {
    const get = await SELF.fetch('https://x/api/admin/panos/get-nothing-p1', auth);
    expect(get.status).toBe(404);
    expect(get.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await get.json()).toEqual({
      error: 'config not found',
      deleting: false,
      hasOriginal: false,
    });
  });

  it('400s a GET with a panoId outside the URL-unreserved charset, still no-store', async () => {
    const r = await SELF.fetch(`https://x/api/admin/panos/${encodeURIComponent('bad/id')}`, auth);
    expect(r.status).toBe(400);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('rejects an unauthenticated GET', async () => {
    const r = await SELF.fetch('https://x/api/admin/panos/get-unauth-p1');
    expect(r.status).toBe(401);
  });

  it('409s a config PUT while a delete tombstone exists', async () => {
    const panoId = 'put-tombstone-p1';
    await env.BUCKET.put(deletingKey(MY_SUB, panoId), '');
    const put = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Resurrected', hotspots: [] }),
    });
    expect(put.status).toBe(409);
    expect(await put.json()).toEqual({ error: 'pano is being deleted' });
    expect(await env.BUCKET.get(configKey(MY_SUB, panoId))).toBeNull();
  });
});

describe('GET /api/admin/tours/:tourId', () => {
  it('reads its own tour with a quoted ETag header and no-store Cache-Control', async () => {
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Get Tour', scenes: [] }),
    });
    const { tourId } = (await create.json()) as { tourId: string };

    const get = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, auth);
    expect(get.status).toBe(200);
    expect(get.headers.get('ETag')).toMatch(/^".+"$/);
    expect(get.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await get.json()) as { tour: { title: string }; etag: string };
    expect(body.tour.title).toBe('Get Tour');
  });

  it('304s on a matching If-None-Match, with the ETag header set and an empty body', async () => {
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Etag Tour', scenes: [] }),
    });
    const { tourId } = (await create.json()) as { tourId: string };
    const get = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, auth);
    const etag = get.headers.get('ETag');

    const notModified = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, {
      headers: { ...auth.headers, 'If-None-Match': etag ?? '' },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('ETag')).toBe(etag);
    expect(await notModified.text()).toBe('');
  });

  it("404s a cross-owner GET instead of exposing the other owner's tour", async () => {
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: authOther.headers,
      body: JSON.stringify({ title: 'Theirs', scenes: [] }),
    });
    const { tourId } = (await create.json()) as { tourId: string };
    const get = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, auth);
    expect(get.status).toBe(404);
    expect(get.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await get.json()).toEqual({ error: 'not found' });
  });

  it('404s a tourId that was never created', async () => {
    const get = await SELF.fetch('https://x/api/admin/tours/never-created-t1', auth);
    expect(get.status).toBe(404);
  });

  it('400s a GET with a tourId outside the URL-unreserved charset, still no-store', async () => {
    const r = await SELF.fetch(
      `https://x/api/admin/tours/${encodeURIComponent('bad/tour|id')}`,
      auth,
    );
    expect(r.status).toBe(400);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('rejects an unauthenticated GET', async () => {
    const r = await SELF.fetch('https://x/api/admin/tours/get-unauth-t1');
    expect(r.status).toBe(401);
  });

  it('?include=configs resolves each scene config, tombstone- and original-aware', async () => {
    const readyPano = 'include-ready-p1';
    const tombstonePano = 'include-tombstone-p1';
    const originalOnlyPano = 'include-original-p1';

    const putConfig = await SELF.fetch(`https://x/api/admin/panos/${readyPano}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId: readyPano, title: 'Ready', hotspots: [] }),
    });
    const { etag: readyEtag } = (await putConfig.json()) as { etag: string };
    await env.BUCKET.put(deletingKey(MY_SUB, tombstonePano), '');
    await env.BUCKET.put(originalKey(MY_SUB, originalOnlyPano), 'original bytes');

    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({
        title: 'Include Configs',
        scenes: [{ panoId: readyPano }, { panoId: tombstonePano }, { panoId: originalOnlyPano }],
      }),
    });
    const { tourId } = (await create.json()) as { tourId: string };

    const get = await SELF.fetch(`https://x/api/admin/tours/${tourId}?include=configs`, auth);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { configs: Record<string, unknown> };
    expect(body.configs[readyPano]).toEqual({
      config: { panoId: readyPano, title: 'Ready', hotspots: [] },
      etag: readyEtag,
    });
    expect(body.configs[tombstonePano]).toEqual({
      missing: true,
      deleting: true,
      hasOriginal: false,
    });
    expect(body.configs[originalOnlyPano]).toEqual({
      missing: true,
      deleting: false,
      hasOriginal: true,
    });
  });

  it('omits configs when ?include is absent', async () => {
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'No Include', scenes: [] }),
    });
    const { tourId } = (await create.json()) as { tourId: string };
    const get = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, auth);
    const body = (await get.json()) as Record<string, unknown>;
    expect(body.configs).toBeUndefined();
  });

  it("?include=configs never leaks another owner's config for a foreign scene panoId", async () => {
    const foreignPano = 'include-foreign-owner-p1';
    // The other owner really does have a config and an original here, so
    // this proves the response reflects the caller's own empty prefix.
    await SELF.fetch(`https://x/api/admin/panos/${foreignPano}/config`, {
      method: 'PUT',
      headers: { ...authOther.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId: foreignPano, title: 'Theirs', hotspots: [] }),
    });
    await env.BUCKET.put(originalKey(OTHER_SUB, foreignPano), 'their original bytes');

    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Foreign Scene', scenes: [{ panoId: foreignPano }] }),
    });
    const { tourId } = (await create.json()) as { tourId: string };

    const get = await SELF.fetch(`https://x/api/admin/tours/${tourId}?include=configs`, auth);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { configs: Record<string, unknown> };
    expect(body.configs[foreignPano]).toEqual({
      missing: true,
      deleting: false,
      hasOriginal: false,
    });
  });

  it('caps ?include=configs scene fetches at MAX_TOUR_SCENES even for a hand-written oversized tour', async () => {
    const tourId = 'oversized-scenes-t1';
    const scenes = Array.from({ length: MAX_TOUR_SCENES + 20 }, (_, i) => ({
      panoId: `oversized-scene-${i}`,
    }));
    // Written directly, bypassing TourDocSchema's cap, to prove the read
    // path guards itself rather than trusting the write-side cap alone.
    await env.BUCKET.put(
      tourKey(MY_SUB, tourId),
      JSON.stringify({ tourId, title: 'Oversized', scenes }),
    );

    const get = await SELF.fetch(`https://x/api/admin/tours/${tourId}?include=configs`, auth);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { configs: Record<string, unknown> };
    expect(Object.keys(body.configs).length).toBe(MAX_TOUR_SCENES);
  });
});

describe('PUT /api/admin/tours/:tourId write guards', () => {
  it('404s a PUT to a tourId that was never created via POST, even with If-Match: *', async () => {
    const r = await SELF.fetch('https://x/api/admin/tours/never-posted-t1', {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ title: 'Ghost', scenes: [] }),
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not found' });
    expect(await env.BUCKET.get(tourKey(MY_SUB, 'never-posted-t1'))).toBeNull();
  });
});

describe('customMetadata writes (unit A2)', () => {
  it('a config PUT stamps customMetadata.title', async () => {
    const panoId = 'meta-config-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Metadata Hall', hotspots: [] }),
    });
    const head = await env.BUCKET.head(configKey(MY_SUB, panoId));
    expect(head?.customMetadata).toEqual({ title: 'Metadata Hall' });
  });

  it('a tour POST stamps title/sceneCount/coverPanoId, and a PUT keeps it current', async () => {
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Meta Tour', scenes: [{ panoId: 'meta-p1' }] }),
    });
    const { tourId } = (await create.json()) as { tourId: string };
    const headAfterCreate = await env.BUCKET.head(tourKey(MY_SUB, tourId));
    expect(headAfterCreate?.customMetadata).toEqual({
      title: 'Meta Tour',
      sceneCount: '1',
      coverPanoId: 'meta-p1',
    });

    await SELF.fetch(`https://x/api/admin/tours/${tourId}`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({
        title: 'Meta Tour Updated',
        scenes: [{ panoId: 'meta-p2' }, { panoId: 'meta-p3' }],
      }),
    });
    const headAfterUpdate = await env.BUCKET.head(tourKey(MY_SUB, tourId));
    expect(headAfterUpdate?.customMetadata).toEqual({
      title: 'Meta Tour Updated',
      sceneCount: '2',
      coverPanoId: 'meta-p2',
    });
  });

  it('a tour with no scenes stamps an empty coverPanoId', async () => {
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'No Scenes', scenes: [] }),
    });
    const { tourId } = (await create.json()) as { tourId: string };
    const head = await env.BUCKET.head(tourKey(MY_SUB, tourId));
    expect(head?.customMetadata).toEqual({ title: 'No Scenes', sceneCount: '0', coverPanoId: '' });
  });
});

describe('GET /api/admin/tours', () => {
  it('rejects an unauthenticated list', async () => {
    const r = await SELF.fetch('https://x/api/admin/tours');
    expect(r.status).toBe(401);
  });

  it('lists a created tour with title/sceneCount/coverPanoId/updatedAt/etag and publish: null', async () => {
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'List Me', scenes: [{ panoId: 'list-cover-p1' }] }),
    });
    const { tourId } = (await create.json()) as { tourId: string };

    const list = await SELF.fetch('https://x/api/admin/tours', auth);
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      tours: Array<{
        tourId: string;
        title: string;
        sceneCount: number;
        coverPanoId: string | null;
        updatedAt: string;
        etag: string;
        publish: unknown;
      }>;
      cursor: string | null;
    };
    const entry = body.tours.find((t) => t.tourId === tourId);
    expect(entry).toEqual({
      tourId,
      title: 'List Me',
      sceneCount: 1,
      coverPanoId: 'list-cover-p1',
      updatedAt: expect.any(String),
      etag: expect.any(String),
      publish: null,
    });
    expect(new Date(entry?.updatedAt ?? '').toString()).not.toBe('Invalid Date');
  });

  it("does not list another owner's tours", async () => {
    await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: authOther.headers,
      body: JSON.stringify({ title: 'Theirs Only', scenes: [] }),
    });
    const list = await SELF.fetch('https://x/api/admin/tours', auth);
    const body = (await list.json()) as { tours: Array<{ title: string }> };
    expect(body.tours.some((t) => t.title === 'Theirs Only')).toBe(false);
  });

  it('a legacy tour written with no customMetadata still lists, via the getJson fallback', async () => {
    const tourId = 'legacy-tour-t1';
    await env.BUCKET.put(
      tourKey(MY_SUB, tourId),
      JSON.stringify({ tourId, title: 'Legacy Tour', scenes: [{ panoId: 'legacy-cover-p1' }] }),
    );
    const list = await SELF.fetch('https://x/api/admin/tours', auth);
    const body = (await list.json()) as {
      tours: Array<{
        tourId: string;
        title: string;
        sceneCount: number;
        coverPanoId: string | null;
      }>;
    };
    const entry = body.tours.find((t) => t.tourId === tourId);
    expect(entry).toEqual({
      tourId,
      title: 'Legacy Tour',
      sceneCount: 1,
      coverPanoId: 'legacy-cover-p1',
      updatedAt: expect.any(String),
      etag: expect.any(String),
      publish: null,
    });
  });

  it('honours ?limit and returns a cursor that resumes to the remaining page', async () => {
    const owner = { headers: { Authorization: 'Bearer good' } };
    const titles = ['Page A', 'Page B', 'Page C'];
    for (const title of titles) {
      await SELF.fetch('https://x/api/admin/tours', {
        method: 'POST',
        headers: owner.headers,
        body: JSON.stringify({ title, scenes: [] }),
      });
    }
    // Every prior test in this describe block also created tours under the
    // same owner, so this counts total-so-far rather than assuming exactly 3.
    const all = await SELF.fetch('https://x/api/admin/tours?limit=100', auth);
    const totalCount = ((await all.json()) as { tours: unknown[] }).tours.length;

    const first = await SELF.fetch('https://x/api/admin/tours?limit=1', auth);
    const firstBody = (await first.json()) as { tours: unknown[]; cursor: string | null };
    expect(firstBody.tours.length).toBe(1);
    expect(firstBody.cursor).not.toBeNull();

    const rest = await SELF.fetch(
      `https://x/api/admin/tours?limit=${totalCount}&cursor=${encodeURIComponent(firstBody.cursor ?? '')}`,
      auth,
    );
    const restBody = (await rest.json()) as { tours: unknown[]; cursor: string | null };
    expect(restBody.tours.length).toBe(totalCount - 1);
  });
});

describe('GET /api/admin/panos summaries (unit A2)', () => {
  it('panoIds stays the full unpaginated list alongside the new panos summaries', async () => {
    const panoId = 'summary-panoids-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Summary', hotspots: [] }),
    });
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const body = (await list.json()) as {
      panoIds: string[];
      panos: Array<{ panoId: string }>;
      cursor: string | null;
    };
    expect(body.panoIds).toContain(panoId);
    expect(body.panos.some((p) => p.panoId === panoId)).toBe(true);
  });

  it('summarizes a config-only pano: hasConfig, no original, tiling none', async () => {
    const panoId = 'summary-config-only-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Config Only', hotspots: [] }),
    });
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const body = (await list.json()) as {
      panos: Array<{
        panoId: string;
        title: string | null;
        hasConfig: boolean;
        hasOriginal: boolean;
        deleting: boolean;
        tiling: string;
        manifest: unknown;
      }>;
    };
    const entry = body.panos.find((p) => p.panoId === panoId);
    expect(entry).toEqual({
      panoId,
      title: 'Config Only',
      hasConfig: true,
      hasOriginal: false,
      deleting: false,
      tiling: 'none',
      manifest: null,
      updatedAt: expect.any(String),
    });
  });

  it('summarizes an uploaded-but-untiled original as pending, with a null title', async () => {
    const panoId = 'summary-pending-p1';
    await env.BUCKET.put(originalKey(MY_SUB, panoId), 'original bytes');
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const body = (await list.json()) as {
      panos: Array<{ panoId: string; title: string | null; hasOriginal: boolean; tiling: string }>;
    };
    const entry = body.panos.find((p) => p.panoId === panoId);
    expect(entry?.title).toBeNull();
    expect(entry?.hasOriginal).toBe(true);
    expect(entry?.tiling).toBe('pending');
  });

  it('summarizes a ready pano: manifest version etag capture matches the original etag', async () => {
    const panoId = 'summary-ready-p1';
    const put = await env.BUCKET.put(originalKey(MY_SUB, panoId), 'original bytes');
    const version = `t1-${put?.etag}`;
    await env.BUCKET.put(
      manifestKey(panoId),
      JSON.stringify({ pano: panoId, version, format: 'webp', tileSize: 256 }),
    );
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const body = (await list.json()) as {
      panos: Array<{
        panoId: string;
        tiling: string;
        manifest: { version: string; format: string; tileSize: number } | null;
      }>;
    };
    const entry = body.panos.find((p) => p.panoId === panoId);
    expect(entry?.tiling).toBe('ready');
    expect(entry?.manifest).toEqual({ version, format: 'webp', tileSize: 256 });
  });

  it('summarizes a replaced original whose old manifest no longer matches as pending, not ready', async () => {
    const panoId = 'summary-replaced-p1';
    await env.BUCKET.put(
      manifestKey(panoId),
      JSON.stringify({ pano: panoId, version: 't1-stale-etag', format: 'webp', tileSize: 256 }),
    );
    // The current original has a different (real) etag than the stale manifest.
    await env.BUCKET.put(originalKey(MY_SUB, panoId), 'new original bytes');
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const body = (await list.json()) as { panos: Array<{ panoId: string; tiling: string }> };
    expect(body.panos.find((p) => p.panoId === panoId)?.tiling).toBe('pending');
  });

  it('summarizes a tile-failed marker matching the current original etag as failed', async () => {
    const panoId = 'summary-failed-p1';
    const put = await env.BUCKET.put(originalKey(MY_SUB, panoId), 'original bytes');
    await env.BUCKET.put(tileFailedKey(MY_SUB, panoId), JSON.stringify({ reason: 'dlq' }), {
      customMetadata: { reason: 'dlq', originalEtag: put?.etag ?? '' },
    });
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const body = (await list.json()) as { panos: Array<{ panoId: string; tiling: string }> };
    expect(body.panos.find((p) => p.panoId === panoId)?.tiling).toBe('failed');
  });

  it('a stale tile-failed marker (superseded by a newer upload) is pending, not failed', async () => {
    const panoId = 'summary-stale-failed-p1';
    await env.BUCKET.put(tileFailedKey(MY_SUB, panoId), JSON.stringify({ reason: 'dlq' }), {
      customMetadata: { reason: 'dlq', originalEtag: 'an-old-etag' },
    });
    await env.BUCKET.put(originalKey(MY_SUB, panoId), 'a newer original');
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const body = (await list.json()) as { panos: Array<{ panoId: string; tiling: string }> };
    expect(body.panos.find((p) => p.panoId === panoId)?.tiling).toBe('pending');
  });

  it('review fix: a same-etag race between a ready manifest and a stale failed marker resolves to ready', async () => {
    const panoId = 'summary-race-p1';
    const put = await env.BUCKET.put(originalKey(MY_SUB, panoId), 'original bytes');
    const version = `t1-${put?.etag}`;
    await env.BUCKET.put(
      manifestKey(panoId),
      JSON.stringify({ pano: panoId, version, format: 'webp', tileSize: 256 }),
    );
    await env.BUCKET.put(tileFailedKey(MY_SUB, panoId), JSON.stringify({ reason: 'dlq' }), {
      customMetadata: { reason: 'dlq', originalEtag: put?.etag ?? '' },
    });
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const body = (await list.json()) as { panos: Array<{ panoId: string; tiling: string }> };
    expect(body.panos.find((p) => p.panoId === panoId)?.tiling).toBe('ready');
  });

  it('a tombstoned pano summarizes as deleting: true', async () => {
    const panoId = 'summary-tombstone-p1';
    await env.BUCKET.put(deletingKey(MY_SUB, panoId), '');
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const body = (await list.json()) as { panos: Array<{ panoId: string; deleting: boolean }> };
    expect(body.panos.find((p) => p.panoId === panoId)?.deleting).toBe(true);
  });

  it('a legacy config with no customMetadata still resolves a title via the getJson fallback', async () => {
    const panoId = 'summary-legacy-title-p1';
    await env.BUCKET.put(
      configKey(MY_SUB, panoId),
      JSON.stringify({ panoId, title: 'Legacy Title', hotspots: [] }),
    );
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const body = (await list.json()) as { panos: Array<{ panoId: string; title: string | null }> };
    expect(body.panos.find((p) => p.panoId === panoId)?.title).toBe('Legacy Title');
  });

  it('honours ?limit and a cursor over the sorted panoId keyset', async () => {
    const a = 'summary-cursor-a-p1';
    const b = 'summary-cursor-b-p1';
    for (const panoId of [a, b]) {
      await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
        method: 'PUT',
        headers: { ...auth.headers, 'If-Match': '*' },
        body: JSON.stringify({ panoId, title: panoId, hotspots: [] }),
      });
    }
    const first = await SELF.fetch(
      `https://x/api/admin/panos?limit=1&cursor=${encodeURIComponent(a)}`,
      auth,
    );
    const body = (await first.json()) as { panos: Array<{ panoId: string }> };
    // Cursor semantics: resumes strictly after the given id in sorted order.
    expect(body.panos[0]?.panoId).toBe(b);
  });
});

describe('GET /api/admin/panos/:panoId status (unit A2)', () => {
  it('the normal 200 response includes a status object alongside config/etag', async () => {
    const panoId = 'status-normal-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Status Normal', hotspots: [] }),
    });
    const get = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, auth);
    const body = (await get.json()) as {
      config: { title: string };
      etag: string;
      status: { hasConfig: boolean; hasOriginal: boolean; deleting: boolean; tiling: string };
    };
    expect(body.status).toEqual({
      hasConfig: true,
      hasOriginal: false,
      deleting: false,
      tiling: 'none',
      manifest: null,
      updatedAt: expect.any(String),
    });
  });

  it('?status=1 returns only {status}, with no config or etag key, for a config-less fresh upload', async () => {
    const panoId = 'status-only-fresh-upload-p1';
    await env.BUCKET.put(originalKey(MY_SUB, panoId), 'original bytes');
    const get = await SELF.fetch(`https://x/api/admin/panos/${panoId}?status=1`, auth);
    expect(get.status).toBe(200);
    const body = (await get.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['status']);
    expect(
      (body.status as { hasOriginal: boolean; hasConfig: boolean; tiling: string }).hasOriginal,
    ).toBe(true);
    expect((body.status as { hasConfig: boolean }).hasConfig).toBe(false);
    expect((body.status as { tiling: string }).tiling).toBe('pending');
  });

  it('?status=1 200s (not 404) for a panoId with nothing at all', async () => {
    const get = await SELF.fetch('https://x/api/admin/panos/status-only-nothing-p1?status=1', auth);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { status: { tiling: string } };
    expect(body.status.tiling).toBe('none');
  });

  it('?status=1 rejects an unauthenticated request', async () => {
    const r = await SELF.fetch('https://x/api/admin/panos/status-unauth-p1?status=1');
    expect(r.status).toBe(401);
  });

  it('?status=1 400s a panoId outside the URL-unreserved charset', async () => {
    const r = await SELF.fetch(
      `https://x/api/admin/panos/${encodeURIComponent('bad/id')}?status=1`,
      auth,
    );
    expect(r.status).toBe(400);
  });
});

describe('DELETE /api/admin/tours/:tourId (unit A2)', () => {
  it('rejects an unauthenticated delete', async () => {
    const r = await SELF.fetch('https://x/api/admin/tours/unauth-delete-t1', { method: 'DELETE' });
    expect(r.status).toBe(401);
  });

  it('400s a tourId outside the URL-unreserved charset', async () => {
    const r = await SELF.fetch(`https://x/api/admin/tours/${encodeURIComponent('bad/tour|id')}`, {
      method: 'DELETE',
      headers: auth.headers,
    });
    expect(r.status).toBe(400);
  });

  it('is idempotent 204 for a tourId that was never created', async () => {
    const r = await SELF.fetch('https://x/api/admin/tours/never-created-delete-t1', {
      method: 'DELETE',
      headers: auth.headers,
    });
    expect(r.status).toBe(204);
  });

  it('deletes the tour document; a repeat DELETE is still 204', async () => {
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Delete Me', scenes: [] }),
    });
    const { tourId } = (await create.json()) as { tourId: string };

    const first = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, {
      method: 'DELETE',
      headers: auth.headers,
    });
    expect(first.status).toBe(204);
    expect(await env.BUCKET.get(tourKey(MY_SUB, tourId))).toBeNull();

    const second = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, {
      method: 'DELETE',
      headers: auth.headers,
    });
    expect(second.status).toBe(204);
  });

  it("204s a caller's DELETE of a tourId only another owner has, without touching that owner's tour", async () => {
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: authOther.headers,
      body: JSON.stringify({ title: 'Not Yours', scenes: [] }),
    });
    const { tourId } = (await create.json()) as { tourId: string };

    const del = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, {
      method: 'DELETE',
      headers: auth.headers,
    });
    expect(del.status).toBe(204);
    expect(await env.BUCKET.get(tourKey(OTHER_SUB, tourId))).not.toBeNull();
  });

  it('deleting a tour also deletes a pano it alone references (original, config and tiles)', async () => {
    const panoId = 'delete-tour-orphan-p1';
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Orphan', hotspots: [] }),
    });
    await env.BUCKET.put(originalKey(MY_SUB, panoId), 'original bytes');
    await env.BUCKET.put(tileVersionPrefix(panoId, 't1-orphan') + '0/px/0-0.webp', 'tile');
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Orphan Owner', scenes: [{ panoId }] }),
    });
    const { tourId } = (await create.json()) as { tourId: string };

    const del = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, {
      method: 'DELETE',
      headers: auth.headers,
    });
    expect(del.status).toBe(204);

    expect(await env.BUCKET.get(originalKey(MY_SUB, panoId))).toBeNull();
    expect(await env.BUCKET.get(configKey(MY_SUB, panoId))).toBeNull();
    expect(
      await env.BUCKET.get(tileVersionPrefix(panoId, 't1-orphan') + '0/px/0-0.webp'),
    ).toBeNull();
  });

  it('Q5: deleting one tour leaves a pano shared with another tour of the same owner untouched', async () => {
    const sharedPano = 'delete-tour-shared-p1';
    await SELF.fetch(`https://x/api/admin/panos/${sharedPano}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId: sharedPano, title: 'Shared', hotspots: [] }),
    });
    await env.BUCKET.put(originalKey(MY_SUB, sharedPano), 'shared original bytes');

    const createA = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Tour A', scenes: [{ panoId: sharedPano }] }),
    });
    const { tourId: tourIdA } = (await createA.json()) as { tourId: string };
    const createB = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Tour B', scenes: [{ panoId: sharedPano }] }),
    });
    const { tourId: tourIdB } = (await createB.json()) as { tourId: string };

    const delA = await SELF.fetch(`https://x/api/admin/tours/${tourIdA}`, {
      method: 'DELETE',
      headers: auth.headers,
    });
    expect(delA.status).toBe(204);

    // Tour A is gone, but the pano it shared with Tour B survives.
    expect(await env.BUCKET.get(tourKey(MY_SUB, tourIdA))).toBeNull();
    expect(await env.BUCKET.get(originalKey(MY_SUB, sharedPano))).not.toBeNull();
    expect(await env.BUCKET.get(configKey(MY_SUB, sharedPano))).not.toBeNull();
    expect(await env.BUCKET.get(tourKey(MY_SUB, tourIdB))).not.toBeNull();

    // Now delete Tour B too: with no other tour referencing it, the shared
    // pano is finally cleaned up.
    const delB = await SELF.fetch(`https://x/api/admin/tours/${tourIdB}`, {
      method: 'DELETE',
      headers: auth.headers,
    });
    expect(delB.status).toBe(204);
    expect(await env.BUCKET.get(originalKey(MY_SUB, sharedPano))).toBeNull();
  });

  it('a delete tour fan-out does not touch a same-panoId pano owned by a different owner', async () => {
    const panoId = 'delete-tour-cross-owner-p1';
    await env.BUCKET.put(originalKey(OTHER_SUB, panoId), 'their original bytes');
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Mine', scenes: [{ panoId }] }),
    });
    const { tourId } = (await create.json()) as { tourId: string };

    await SELF.fetch(`https://x/api/admin/tours/${tourId}`, {
      method: 'DELETE',
      headers: auth.headers,
    });

    expect(await env.BUCKET.get(originalKey(OTHER_SUB, panoId))).not.toBeNull();
  });
});

describe('review fix: manifest is not returned without ownership proof', () => {
  it('?status=1, the full GET and the list all return manifest: null for a panoId the caller never owned', async () => {
    const panoId = 'owner-leak-p1';
    // B owns and fully tiles this pano.
    const put = await env.BUCKET.put(originalKey(OTHER_SUB, panoId), 'their original bytes');
    const version = `t1-${put?.etag}`;
    await env.BUCKET.put(
      manifestKey(panoId),
      JSON.stringify({ pano: panoId, version, format: 'webp', tileSize: 256 }),
    );

    // A queries the same panoId under their own (empty) prefix.
    const status = await SELF.fetch(`https://x/api/admin/panos/${panoId}?status=1`, auth);
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { status: { manifest: unknown; tiling: string } };
    expect(statusBody.status.manifest).toBeNull();
    expect(statusBody.status.tiling).toBe('none');

    const full = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, auth);
    // A has no config either, so this is the tombstone-aware 404 - but the
    // point is it must never carry B's manifest/tiling data in any form.
    expect(full.status).toBe(404);

    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const listBody = (await list.json()) as {
      panos: Array<{ panoId: string; manifest: unknown; tiling: string }>;
    };
    // A never uploaded/configured this panoId, so it must not even list for A.
    expect(listBody.panos.find((p) => p.panoId === panoId)).toBeUndefined();
  });

  it("the full 200 GET never carries another owner's manifest even when the caller has their own config for the same panoId", async () => {
    const panoId = 'owner-leak-shared-id-p1';
    const put = await env.BUCKET.put(originalKey(OTHER_SUB, panoId), 'their original bytes');
    const version = `t1-${put?.etag}`;
    await env.BUCKET.put(
      manifestKey(panoId),
      JSON.stringify({ pano: panoId, version, format: 'webp', tileSize: 256 }),
    );
    // A has a config under the same panoId but never uploaded an original -
    // proves the manifest gate is originalObj, not merely "some object exists".
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Mine, no original', hotspots: [] }),
    });

    const full = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, auth);
    expect(full.status).toBe(200);
    const body = (await full.json()) as { status: { manifest: unknown; tiling: string } };
    expect(body.status.manifest).toBeNull();
    expect(body.status.tiling).toBe('none');
  });
});

describe('review fix: title truncation for R2 customMetadata (8192-byte limit, error 10012)', () => {
  const hugeTitle = (ch: string) => ch.repeat(9000);

  it('a 9000-char tour POST title still 200s, and the list shows the truncated title', async () => {
    const title = hugeTitle('a');
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title, scenes: [] }),
    });
    expect(create.status).toBe(201);
    const { tourId } = (await create.json()) as { tourId: string };

    const list = await SELF.fetch('https://x/api/admin/tours', auth);
    const body = (await list.json()) as { tours: Array<{ tourId: string; title: string }> };
    const entry = body.tours.find((t) => t.tourId === tourId);
    expect(entry?.title.length).toBe(256);
    expect(entry?.title).toBe(title.slice(0, 256));

    // The direct GET still returns the full, untruncated title from the doc.
    const get = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, auth);
    const getBody = (await get.json()) as { tour: { title: string } };
    expect(getBody.tour.title.length).toBe(9000);
  });

  it('a 9000-char tour PUT title still 200s, and the list shows the truncated title', async () => {
    const create = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Short', scenes: [] }),
    });
    const { tourId } = (await create.json()) as { tourId: string };
    const title = hugeTitle('b');
    const update = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ title, scenes: [] }),
    });
    expect(update.status).toBe(200);

    const list = await SELF.fetch('https://x/api/admin/tours', auth);
    const body = (await list.json()) as { tours: Array<{ tourId: string; title: string }> };
    expect(body.tours.find((t) => t.tourId === tourId)?.title.length).toBe(256);
  });

  it('a 9000-char pano config PUT title still 200s, and the list shows the truncated title', async () => {
    const panoId = 'huge-title-config-p1';
    const title = hugeTitle('c');
    const put = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title, hotspots: [] }),
    });
    expect(put.status).toBe(200);

    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    const body = (await list.json()) as { panos: Array<{ panoId: string; title: string | null }> };
    expect(body.panos.find((p) => p.panoId === panoId)?.title?.length).toBe(256);

    // The direct GET still returns the full, untruncated title from the doc.
    const get = await SELF.fetch(`https://x/api/admin/panos/${panoId}`, auth);
    const getBody = (await get.json()) as { config: { title: string } };
    expect(getBody.config.title.length).toBe(9000);
  });
});

describe('review fix: ?limit and ?cursor validation on both list routes', () => {
  it('400s a non-integer, zero, negative or over-max ?limit on GET /api/admin/tours', async () => {
    for (const limit of ['0.5', '0', '-1', '101', 'abc']) {
      const r = await SELF.fetch(`https://x/api/admin/tours?limit=${limit}`, auth);
      expect(r.status).toBe(400);
    }
  });

  it('400s a non-integer, zero, negative or over-max ?limit on GET /api/admin/panos', async () => {
    for (const limit of ['0.5', '0', '-1', '101', 'abc']) {
      const r = await SELF.fetch(`https://x/api/admin/panos?limit=${limit}`, auth);
      expect(r.status).toBe(400);
    }
  });

  it('accepts the boundary limits 1 and 100 on both list routes', async () => {
    const toursMin = await SELF.fetch('https://x/api/admin/tours?limit=1', auth);
    const toursMax = await SELF.fetch('https://x/api/admin/tours?limit=100', auth);
    const panosMin = await SELF.fetch('https://x/api/admin/panos?limit=1', auth);
    const panosMax = await SELF.fetch('https://x/api/admin/panos?limit=100', auth);
    expect([toursMin.status, toursMax.status, panosMin.status, panosMax.status]).toEqual([
      200, 200, 200, 200,
    ]);
  });

  it('400s a cursor outside the URL-unreserved charset on GET /api/admin/tours', async () => {
    const r = await SELF.fetch(
      `https://x/api/admin/tours?cursor=${encodeURIComponent('bad/cursor|1')}`,
      auth,
    );
    expect(r.status).toBe(400);
  });

  it('400s a cursor outside the URL-unreserved charset on GET /api/admin/panos', async () => {
    const r = await SELF.fetch(
      `https://x/api/admin/panos?cursor=${encodeURIComponent('bad/cursor|1')}`,
      auth,
    );
    expect(r.status).toBe(400);
  });
});

describe('review fix: tours list page boundary never splits a tour from its publish.json', () => {
  it('limit=1 across two tours, one with a publish.json sidecar, visits each tour exactly once', async () => {
    const createA = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Boundary A', scenes: [] }),
    });
    const { tourId: tourIdA } = (await createA.json()) as { tourId: string };
    const createB = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify({ title: 'Boundary B', scenes: [] }),
    });
    const { tourId: tourIdB } = (await createB.json()) as { tourId: string };
    // Hand-written, forward-compat with unit B2's future publish.json writer.
    await env.BUCKET.put(
      `tours/${encodeId(MY_SUB)}/${tourIdA}/publish.json`,
      JSON.stringify({ slug: 'boundary-a', visibility: 'public' }),
      { customMetadata: { slug: 'boundary-a', visibility: 'public' } },
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = cursor
        ? `https://x/api/admin/tours?limit=1&cursor=${encodeURIComponent(cursor)}`
        : 'https://x/api/admin/tours?limit=1';
      const r = await SELF.fetch(url, auth);
      const body = (await r.json()) as { tours: Array<{ tourId: string }>; cursor: string | null };
      expect(body.tours.length).toBeLessThanOrEqual(1);
      seen.push(...body.tours.map((t) => t.tourId));
      if (body.cursor === null) break;
      cursor = body.cursor;
    }
    expect(seen).toContain(tourIdA);
    expect(seen).toContain(tourIdB);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
