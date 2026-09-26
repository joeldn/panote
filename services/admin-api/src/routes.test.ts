import {
  configKey,
  deletingKey,
  manifestKey,
  MAX_TOUR_SCENES,
  originalKey,
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
