import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

// Test seam: authenticate() reads globalThis.__verifyJwt when it is set.
// Installed here through setTestJwtVerifier - the only sanctioned way to reach
// it (see the port spec section 0.8). Never touch globalThis directly.
beforeAll(() => {
  setTestJwtVerifier(async (t) =>
    t === 'good' ? { sub: 'auth0|me' } : Promise.reject(new Error('bad')),
  );
});

const auth = { headers: { Authorization: 'Bearer good' } };

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

  it('deletes a pano and it no longer lists', async () => {
    const panoId = 'delete-p1';
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
    expect(((await list.json()) as { panoIds: string[] }).panoIds).not.toContain(panoId);
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

  it('400s on a tour body that fails TourDocSchema', async () => {
    const r = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: auth.headers,
      // Missing the required `title` field.
      body: '{}',
    });
    expect(r.status).toBe(400);
  });
});
