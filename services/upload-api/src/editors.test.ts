import {
  accountDisabledKey,
  membersKey,
  originalKey,
  tourKey,
  tourOwnerKey,
  tourTransferKey,
  uploadedForKey,
  deletingKey,
  uploadLogKey,
  userUploadLogPrefix,
  type TourMembers,
  type UploadUsage,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// An editor of someone else's tour uploads into the owner's account (members.ts in
// contracts). R2 is a small in-memory fake behind the S3 API's fetch.

const OWNER = 'auth0|owner';
const EDITOR = 'auth0|editor';
const STRANGER = 'auth0|stranger';
const TOUR = 'tour-shared';

beforeAll(() => {
  setTestJwtVerifier(async (t: string) => {
    if (t === 'owner') return { sub: OWNER };
    if (t === 'editor') return { sub: EDITOR };
    if (t === 'stranger') return { sub: STRANGER };
    throw new Error('bad');
  });
});

let objects: Map<string, string>;

const keyOf = (input: Request | string): string => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  // https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
  return decodeURIComponent(url.pathname).split('/').slice(2).join('/');
};

const listing = (prefix: string): Response => {
  const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
  const contents = keys
    .map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.length}</Size></Contents>`)
    .join('');
  return new Response(
    `<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
  );
};

beforeEach(() => {
  const members: TourMembers = {
    v: 1,
    ownerEmail: 'owner@example.com',
    members: [
      {
        id: 'm1',
        sub: EDITOR,
        email: 'editor@example.com',
        role: 'editor',
        addedAt: '2026-10-23T00:00:00Z',
      },
    ],
    invites: [],
  };
  objects = new Map([
    [
      tourKey(OWNER, TOUR),
      JSON.stringify({ tourId: TOUR, title: 'T', scenes: [{ panoId: 'p-in' }] }),
    ],
    [tourOwnerKey(TOUR), JSON.stringify({ v: 1, sub: OWNER })],
    [membersKey(OWNER, TOUR), JSON.stringify(members)],
    [originalKey(OWNER, 'p-in'), 'bytes'],
    [originalKey(OWNER, 'p-other'), 'bytes'],
  ]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request | string) => {
      const req = typeof input === 'string' ? new Request(input) : input;
      const url = new URL(req.url);
      if (url.searchParams.has('list-type')) {
        return listing(url.searchParams.get('prefix') ?? '');
      }
      const key = keyOf(req);
      if (req.method === 'PUT') {
        objects.set(key, await req.text());
        return new Response(null, { status: 200 });
      }
      const body = objects.get(key);
      if (body === undefined) return new Response(null, { status: 404 });
      // R2 sends an ETag on every 200: a replace's URL is pinned to it (If-Match).
      return new Response(req.method === 'HEAD' ? null : body, {
        status: 200,
        headers: { etag: `"${body.length}"` },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const post = (who: string, body: unknown) =>
  SELF.fetch('https://x/api/upload-url', {
    method: 'POST',
    headers: { Authorization: `Bearer ${who}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const upload = { contentType: 'image/jpeg', size: 1024 };
const logged = (sub: string) =>
  [...objects.keys()].filter((k) => k.startsWith(userUploadLogPrefix(sub))).length;

describe('an editor uploading to a shared tour', () => {
  it("puts the original in the owner's account and counts it against both", async () => {
    const r = await post('editor', { ...upload, tourId: TOUR });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { panoId: string; key: string };
    expect(j.key).toBe(originalKey(OWNER, j.panoId));
    expect(logged(EDITOR)).toBe(1);
    expect(logged(OWNER)).toBe(1);
    // Whose upload it is, for which tour: the one tour an editor may add it to.
    expect(JSON.parse(objects.get(uploadedForKey(OWNER, j.panoId))!)).toEqual({
      v: 1,
      tourId: TOUR,
      sub: EDITOR,
    });
  });

  it("leaves no uploader record on the owner's own upload or a replace", async () => {
    const own = (await (await post('owner', { ...upload, tourId: TOUR })).json()) as {
      panoId: string;
    };
    expect(objects.has(uploadedForKey(OWNER, own.panoId))).toBe(false);
    expect((await post('editor', { ...upload, tourId: TOUR, panoId: 'p-in' })).status).toBe(200);
    expect(objects.has(uploadedForKey(OWNER, 'p-in'))).toBe(false);
  });

  it('is refused for a tour they are not on', async () => {
    const r = await post('stranger', { ...upload, tourId: TOUR });
    expect(r.status).toBe(404);
    expect(logged(STRANGER)).toBe(0);
  });

  it("goes to the caller's own account without a tourId", async () => {
    const r = await post('editor', upload);
    const j = (await r.json()) as { panoId: string; key: string };
    expect(j.key).toBe(originalKey(EDITOR, j.panoId));
    expect(logged(OWNER)).toBe(0);
  });

  it('replaces only a scene of that tour', async () => {
    const inTour = await post('editor', { ...upload, tourId: TOUR, panoId: 'p-in' });
    expect(inTour.status).toBe(200);
    expect(((await inTour.json()) as { key: string }).key).toBe(originalKey(OWNER, 'p-in'));
    const other = await post('editor', { ...upload, tourId: TOUR, panoId: 'p-other' });
    expect(other.status).toBe(404);
  });

  it("refuses once the owner's account is disabled", async () => {
    objects.set(accountDisabledKey(OWNER), '{}');
    const r = await post('editor', { ...upload, tourId: TOUR });
    expect(r.status).toBe(403);
  });

  it('refuses while the tour is changing owner, owner and editor alike', async () => {
    objects.set(tourTransferKey(TOUR), '{}');
    expect((await post('editor', { ...upload, tourId: TOUR })).status).toBe(409);
    expect((await post('owner', { ...upload, tourId: TOUR })).status).toBe(409);
    expect(logged(OWNER)).toBe(0);
  });

  it('stops when either daily limit is reached', async () => {
    // The owner's day is used up (wrangler.jsonc sets 50).
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    for (let i = 0; i < 50; i++) {
      objects.set(`${userUploadLogPrefix(OWNER)}${stamp}-x${i}`, '');
    }
    const r = await post('editor', { ...upload, tourId: TOUR });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'daily upload limit reached' });
    expect(logged(EDITOR)).toBe(0);
  });

  it('gives an editor a plan image upload for the tour', async () => {
    const r = await post('editor', {
      kind: 'plan',
      tourId: TOUR,
      contentType: 'image/webp',
      size: 2048,
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { key: string }).key).toMatch(`pub/plans/${TOUR}/`);
    expect((await post('stranger', { kind: 'plan', tourId: TOUR, ...upload })).status).toBe(404);
  });

  it('checks the tourId', async () => {
    const r = await post('editor', { ...upload, tourId: 'bad id' });
    expect(r.status).toBe(400);
  });
});

// The account page's read, on the same route: what the caller holds against the limits.
describe('GET /api/upload-url', () => {
  const usage = (who: string) =>
    SELF.fetch('https://x/api/upload-url', { headers: { Authorization: `Bearer ${who}` } });

  it('counts the panos, originals and the past day of upload URLs, with the limits', async () => {
    const now = Date.now();
    objects.set(originalKey(OWNER, 'p-gone'), 'bytes');
    objects.set(deletingKey(OWNER, 'p-gone'), '');
    objects.set(uploadLogKey(OWNER, new Date(now - 60_000), 'p-in'), '');
    objects.set(uploadLogKey(OWNER, new Date(now - 25 * 60 * 60 * 1000), 'p-old'), '');
    const r = await usage('owner');
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await r.json<UploadUsage>()).toEqual({
      panos: 2,
      bytes: 10,
      uploadsToday: 1,
      limits: { maxPanos: 500, maxBytes: 21474836480, maxUploadsPerDay: 50 },
    });
    // A read: the expired entry is left for the next upload-URL request to prune.
    expect(logged(OWNER)).toBe(2);
  });

  it("is the caller's own account, not the tours they edit", async () => {
    expect(await (await usage('editor')).json<UploadUsage>()).toMatchObject({
      panos: 0,
      bytes: 0,
      uploadsToday: 0,
    });
  });

  it('needs a signed-in user, and takes no other method', async () => {
    expect((await usage('nope')).status).toBe(401);
    const put = await SELF.fetch('https://x/api/upload-url', {
      method: 'PUT',
      headers: { Authorization: 'Bearer owner' },
    });
    expect(put.status).toBe(404);
  });
});
