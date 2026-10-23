import {
  accountDeletionKey,
  accountDisabledKey,
  exploreHiddenKey,
  originalKey,
  RECENT_AUTH_MAX_AGE_SECONDS,
  REAUTH_REQUIRED_ERROR,
  SUPPORT_USERS_PATH,
  trashKey,
  uploadLogKey,
  type SupportLookupOk,
  type SupportUserView,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

// Storage is shared between it() cases in this file, so each case uses its own owner.
// `good:<who>` signed in just now; `stale:<who>` too long ago.
beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    const [kind = '', who = ''] = t.split(':');
    const now = Math.floor(Date.now() / 1000);
    if (kind === 'good') return { sub: `auth0|${who}`, authTime: now };
    if (kind === 'stale')
      return { sub: `auth0|${who}`, authTime: now - RECENT_AUTH_MAX_AGE_SECONDS - 5 };
    throw new Error('bad');
  });
});

const OPERATOR = 'good:operator';
const subOf = (who: string) => `auth0|${who}`;
const userPath = (sub: string, rest = '') =>
  `https://x${SUPPORT_USERS_PATH}/${encodeURIComponent(sub)}${rest}`;

const get = (url: string, token = OPERATOR) =>
  SELF.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
const post = (url: string, body: unknown = {}, token = OPERATOR) =>
  SELF.fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const createTour = async (who: string, title = 'Old town'): Promise<string> => {
  const r = await post('https://x/api/admin/tours', { title, scenes: [] }, `good:${who}`);
  expect(r.status).toBe(201);
  return ((await r.json()) as { tourId: string }).tourId;
};

const view = async (sub: string): Promise<SupportUserView> => {
  const r = await get(userPath(sub));
  expect(r.status).toBe(200);
  return r.json();
};

describe('the gate', () => {
  it('is a plain 404 for anyone but an operator, reads and writes', async () => {
    const sub = subOf('gated');
    expect((await get(userPath(sub), 'good:someone')).status).toBe(404);
    expect((await post(userPath(sub, '/disable'), { reason: 'x' }, 'good:someone')).status).toBe(
      404,
    );
    expect(await env.BUCKET.head(accountDisabledKey(sub))).toBeNull();
  });
});

describe('lookup', () => {
  const lookup = (q: string) =>
    get(`https://x${SUPPORT_USERS_PATH}/lookup?q=${encodeURIComponent(q)}`);

  it('reads an account ID as itself', async () => {
    const r = await lookup('google-oauth2|123');
    expect(await r.json<SupportLookupOk>()).toEqual({
      sub: 'google-oauth2|123',
      via: 'sub',
      tourId: null,
    });
  });

  it('finds the owner of a tourId, a slug and a share link', async () => {
    const tourId = await createTour('look');
    await env.BUCKET.put(
      'slugs/old-town-look.json',
      JSON.stringify({ v: 1, kind: 'tour', tourId }),
    );
    const want = { sub: subOf('look'), tourId };
    expect(await (await lookup(tourId)).json()).toEqual({ ...want, via: 'tour' });
    expect(await (await lookup('old-town-look')).json()).toEqual({ ...want, via: 'slug' });
    expect(await (await lookup('https://panote.io/s/Old-Town-Look?scene=2#x')).json()).toEqual({
      ...want,
      via: 'slug',
    });
  });

  it('answers 404 for what it cannot find, and 400 for nothing', async () => {
    expect((await lookup('no-such-slug')).status).toBe(404);
    expect((await lookup('../../etc')).status).toBe(404);
    expect((await get(`https://x${SUPPORT_USERS_PATH}/lookup`)).status).toBe(400);
  });
});

describe('one account', () => {
  it('shows tours, usage, trash and state', async () => {
    const sub = subOf('view');
    const tourId = await createTour('view');
    await env.BUCKET.put(exploreHiddenKey(tourId), '{}');
    await env.BUCKET.put(originalKey(sub, 'p1'), new Uint8Array(10));
    await env.BUCKET.put(uploadLogKey(sub, new Date(), 'p1'), '');
    await env.BUCKET.put(uploadLogKey(sub, new Date(Date.now() - 2 * 86_400_000), 'p0'), '');
    const today = new Date().toISOString().slice(0, 10);
    await env.BUCKET.put(trashKey(today, originalKey(sub, 'gone')), new Uint8Array(7));

    const v = await view(sub);
    expect(v.sub).toBe(sub);
    expect(v.disabled).toBeNull();
    expect(v.deletion).toBeNull();
    expect(v.usage).toEqual({ panos: 1, bytes: 10, uploadsToday: 1, tours: 1 });
    expect(v.limits.maxTours).toBe(200);
    expect(v.tours).toEqual([
      expect.objectContaining({
        tourId,
        title: 'Old town',
        publish: null,
        hiddenFromExplore: true,
        editors: 0,
        transferring: false,
      }),
    ]);
    expect(v.trash).toEqual([
      { date: today, key: originalKey(sub, 'gone'), panoId: 'gone', bytes: 7 },
    ]);
  });

  it('shows an account with nothing as empty, not missing', async () => {
    const v = await view(subOf('nobody'));
    expect(v.tours).toEqual([]);
    expect(v.usage).toEqual({ panos: 0, bytes: 0, uploadsToday: 0, tours: 0 });
  });
});

describe('writes', () => {
  it('disables and enables an account, which blocks and unblocks its writes', async () => {
    const sub = subOf('ban');
    expect((await post(userPath(sub, '/disable'), {})).status).toBe(400);
    const r = await post(userPath(sub, '/disable'), { reason: 'case 3' });
    expect(r.status).toBe(200);
    expect((await r.json<SupportUserView>()).disabled).toMatchObject({ reason: 'case 3' });
    const blocked = await post('https://x/api/admin/tours', { title: 'x', scenes: [] }, 'good:ban');
    expect(blocked.status).toBe(403);

    expect((await post(userPath(sub, '/enable'))).status).toBe(200);
    expect(await env.BUCKET.head(accountDisabledKey(sub))).toBeNull();
    expect((await createTour('ban')).length).toBeGreaterThan(0);
  });

  it('hides and shows a tour on Explore, and unpublishes it', async () => {
    const sub = subOf('tour');
    const tourId = await createTour('tour');
    const act = (action: string) => post(userPath(sub, `/tours/${tourId}`), { action });
    expect((await act('hide')).status).toBe(200);
    expect(await env.BUCKET.head(exploreHiddenKey(tourId))).not.toBeNull();
    expect((await act('unhide')).status).toBe(200);
    expect(await env.BUCKET.head(exploreHiddenKey(tourId))).toBeNull();
    expect((await act('unpublish')).status).toBe(200);
    expect((await act('delete')).status).toBe(400);
  });

  it('refuses a tour the account does not own', async () => {
    const tourId = await createTour('mine');
    const r = await post(userPath(subOf('other'), `/tours/${tourId}`), { action: 'hide' });
    expect(r.status).toBe(404);
  });

  it('restores an original from the trash, once', async () => {
    const sub = subOf('restore');
    const today = new Date().toISOString().slice(0, 10);
    await env.BUCKET.put(trashKey(today, originalKey(sub, 'p9')), new Uint8Array(3));
    const restore = () => post(userPath(sub, '/restore'), { date: today, panoId: 'p9' });
    expect((await restore()).status).toBe(200);
    expect(await env.BUCKET.head(originalKey(sub, 'p9'))).not.toBeNull();
    expect((await restore()).status).toBe(409);
    expect((await post(userPath(sub, '/restore'), { date: today, panoId: 'nope' })).status).toBe(
      404,
    );
  });

  it('closes an account only when confirm repeats its ID', async () => {
    const sub = subOf('close');
    expect((await post(userPath(sub, '/close'), { confirm: 'auth0|other' })).status).toBe(400);
    const r = await post(userPath(sub, '/close'), { confirm: sub });
    expect(r.status).toBe(200);
    expect((await r.json<SupportUserView>()).deletion).not.toBeNull();
    expect(await env.BUCKET.head(accountDeletionKey(sub))).not.toBeNull();
  });

  it('wants a recent sign-in for every write, not for reads', async () => {
    const sub = subOf('stale');
    const r = await post(userPath(sub, '/disable'), { reason: 'x' }, 'stale:operator');
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: REAUTH_REQUIRED_ERROR });
    expect(await env.BUCKET.head(accountDisabledKey(sub))).toBeNull();
    expect((await get(userPath(sub), 'stale:operator')).status).toBe(200);
  });
});
