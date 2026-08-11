import { tourKey } from '@internal/contracts';
import { getJson } from '@internal/worker-kit/r2-binding';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

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

  it('428s when a mutating update omits If-Match', async () => {
    const panoId = 'missing-if-match-p1';
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
    await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Hall', hotspots: [] }),
    });
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
  });

  it('round-trips a panoId that needs percent-encoding through create and list', async () => {
    // A caller-supplied id containing URL-significant characters must come
    // back from GET /panos exactly as it was sent to PUT .../config - not
    // percent-encoded (which a correctly-behaving client would then
    // double-encode on its next request).
    const panoId = 'probe pano|1';
    const put = await SELF.fetch(`https://x/api/admin/panos/${encodeURIComponent(panoId)}/config`, {
      method: 'PUT',
      headers: { ...auth.headers, 'If-Match': '*' },
      body: JSON.stringify({ panoId, title: 'Probe', hotspots: [] }),
    });
    expect(put.status).toBe(200);
    const list = await SELF.fetch('https://x/api/admin/panos', auth);
    expect(((await list.json()) as { panoIds: string[] }).panoIds).toContain(panoId);
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

  it('400s on a tour body that fails TourDocSchema', async () => {
    const r = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      // Missing the required `title` field.
      body: '{}',
    });
    expect(r.status).toBe(400);
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
