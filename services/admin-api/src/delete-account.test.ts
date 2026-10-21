import {
  ACCOUNT_DELETE_CONFIRMATION,
  accountDeletionKey,
  configKey,
  deletingKey,
  manifestKey,
  originalKey,
  publishKey,
  pubTourKey,
  storedSlugKey,
  tileVersionPrefix,
  tourKey,
  type AccountDeletionRecord,
} from '@internal/contracts';
import { getJson } from '@internal/worker-kit/r2-binding';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_MARKER_DAYS,
  deleteAccount,
  sweepAccountDeletions,
  type AccountDeps,
} from './delete-account.js';
import { unpublish } from './publish.js';

// Storage is shared between it() cases in this file, so each case uses its own
// subs, tourIds, panoIds and slugs.
beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t.startsWith('good:')) return { sub: `auth0|${t.slice(5)}` };
    return Promise.reject(new Error('bad'));
  });
});

const bearer = (who: string) => ({ Authorization: `Bearer good:${who}` });
const subOf = (who: string) => `auth0|${who}`;

const deleteAccountReq = (who: string | null, body: unknown) =>
  SELF.fetch('https://x/api/admin/account', {
    method: 'DELETE',
    headers: { ...(who ? bearer(who) : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const put = (key: string, value: unknown = '') =>
  env.BUCKET.put(key, typeof value === 'string' ? value : JSON.stringify(value));

const has = async (key: string) => !!(await env.BUCKET.head(key));

const statsOf = async (tourId: string) =>
  (await env.STATS.get(env.STATS.idFromName(tourId)).fetch('https://do/')).json();
const view = (tourId: string) =>
  env.STATS.get(env.STATS.idFromName(tourId)).fetch('https://do/view', { method: 'POST' });

/** A published tour with a live slug, one redirect alias, a bundle and one tiled pano. */
const seedAccount = async (sub: string, tag: string) => {
  const tourId = `${tag}-tour`;
  const panoId = `${tag}-pano`;
  const slug = `${tag}-live`;
  const alias = `${tag}-old`;
  await put(tourKey(sub, tourId), { tourId, title: 't', scenes: [{ panoId }] });
  await put(publishKey(sub, tourId), {
    slug,
    visibility: 'public',
    publishedAt: '2026-10-01T00:00:00.000Z',
    aliases: [alias],
  });
  await put(storedSlugKey(slug)!, { v: 1, kind: 'tour', tourId });
  await put(storedSlugKey(alias)!, {
    v: 1,
    kind: 'redirect',
    tourId,
    redirect: slug,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  await put(pubTourKey(tourId), { v: 1, tourId });
  await put(originalKey(sub, panoId), 'bytes');
  await put(configKey(sub, panoId), { panoId, title: 'p', hotspots: [] });
  await put(manifestKey(panoId), '{}');
  await put(`${tileVersionPrefix(panoId, 'v1')}0/0_0.webp`, 'tile');
  await view(tourId);
  return { tourId, panoId, slug, alias };
};

const everyKey = (sub: string, s: Awaited<ReturnType<typeof seedAccount>>) => [
  tourKey(sub, s.tourId),
  publishKey(sub, s.tourId),
  storedSlugKey(s.slug)!,
  storedSlugKey(s.alias)!,
  pubTourKey(s.tourId),
  originalKey(sub, s.panoId),
  configKey(sub, s.panoId),
  manifestKey(s.panoId),
  `${tileVersionPrefix(s.panoId, 'v1')}0/0_0.webp`,
];

const marker = async (sub: string) =>
  (await getJson<AccountDeletionRecord>(env.BUCKET, accountDeletionKey(sub)))?.value ?? null;

describe('DELETE /api/admin/account', () => {
  it('needs a signed-in owner', async () => {
    const r = await deleteAccountReq(null, { confirm: ACCOUNT_DELETE_CONFIRMATION });
    expect(r.status).toBe(401);
  });

  it.each([
    ['no body', undefined],
    ['the wrong phrase', { confirm: 'delete' }],
    ['different case', { confirm: ACCOUNT_DELETE_CONFIRMATION.toUpperCase() }],
  ])('400s with %s and touches nothing', async (_label, body) => {
    const who = `acct-noconfirm-${String(_label).replace(/\W/g, '')}`;
    const seeded = await seedAccount(subOf(who), who);
    const r = await deleteAccountReq(who, body);
    expect(r.status).toBe(400);
    expect(await marker(subOf(who))).toBeNull();
    for (const key of everyKey(subOf(who), seeded)) expect(await has(key)).toBe(true);
  });

  it("deletes everything the owner has, and nothing of anyone else's", async () => {
    const mine = await seedAccount(subOf('acct-me'), 'acct-me');
    const theirs = await seedAccount(subOf('acct-them'), 'acct-them');

    const r = await deleteAccountReq('acct-me', { confirm: ACCOUNT_DELETE_CONFIRMATION });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'deleted' });

    for (const key of everyKey(subOf('acct-me'), mine)) expect(await has(key)).toBe(false);
    expect(await statsOf(mine.tourId)).toEqual({ views: 0, likes: 0 });
    const record = await marker(subOf('acct-me'));
    expect(record).toMatchObject({ v: 1, sub: subOf('acct-me') });
    expect(record?.completedAt).toBeDefined();

    for (const key of everyKey(subOf('acct-them'), theirs)) expect(await has(key)).toBe(true);
    expect(await statsOf(theirs.tourId)).toEqual({ views: 1, likes: 0 });
    expect(await marker(subOf('acct-them'))).toBeNull();
  });

  it('leaves the account read-only: writes 410, reads still work, a retry succeeds', async () => {
    const who = 'acct-readonly';
    await seedAccount(subOf(who), who);
    const ok = await deleteAccountReq(who, { confirm: ACCOUNT_DELETE_CONFIRMATION });
    expect(ok.status).toBe(200);
    const first = await marker(subOf(who));

    const writes: [string, string][] = [
      ['POST', '/api/admin/tours'],
      ['PUT', '/api/admin/panos/acct-readonly-new/config'],
      ['PUT', '/api/admin/tours/acct-readonly-tour'],
      ['DELETE', '/api/admin/tours/acct-readonly-tour'],
      ['POST', '/api/admin/tours/acct-readonly-tour/publish'],
      ['PATCH', '/api/admin/tours/acct-readonly-tour/visibility'],
    ];
    for (const [method, path] of writes) {
      const r = await SELF.fetch(`https://x${path}`, {
        method,
        headers: { ...bearer(who), 'If-Match': '*' },
        body: '{}',
      });
      expect([method, path, r.status]).toEqual([method, path, 410]);
      expect(await r.json()).toEqual({ error: 'account deleted' });
    }
    expect(await has(configKey(subOf(who), 'acct-readonly-new'))).toBe(false);

    const list = await SELF.fetch('https://x/api/admin/tours', { headers: bearer(who) });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ tours: [] });

    const again = await deleteAccountReq(who, { confirm: ACCOUNT_DELETE_CONFIRMATION });
    expect(again.status).toBe(200);
    // The first request's timestamps stand.
    expect(await marker(subOf(who))).toEqual(first);
  });

  it("doesn't block another owner's writes", async () => {
    await seedAccount(subOf('acct-gone'), 'acct-gone');
    await deleteAccountReq('acct-gone', { confirm: ACCOUNT_DELETE_CONFIRMATION });
    const r = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: bearer('acct-stays'),
      body: JSON.stringify({ title: 'Still here', scenes: [] }),
    });
    expect(r.status).toBe(201);
  });
});

const depsWith = (overrides: Partial<AccountDeps> = {}): AccountDeps => ({
  bucket: env.BUCKET,
  unpublishTour: (sub, tourId) => unpublish(env.BUCKET, sub, tourId),
  clearStats: async (tourId) => {
    await env.STATS.get(env.STATS.idFromName(tourId)).fetch('https://do/', { method: 'DELETE' });
  },
  ...overrides,
});

describe('deleteAccount: interrupted, then resumed', () => {
  it('reports pending and leaves the account marked; the sweep finishes it', async () => {
    const sub = subOf('acct-resume');
    const seeded = await seedAccount(sub, 'acct-resume');
    // A tombstoned pano from an earlier, interrupted pano delete goes too.
    await put(deletingKey(sub, 'acct-resume-tomb'), '');
    const now = new Date('2026-10-20T10:00:00.000Z');

    const failing = depsWith({ clearStats: vi.fn().mockRejectedValue(new Error('stats down')) });
    const partial = await deleteAccount(failing, sub, now);
    expect(partial.status).toBe('pending');
    // The marker is there but not complete, and the tour still lists for a retry.
    expect(await marker(sub)).toEqual({ v: 1, sub, requestedAt: now.toISOString() });
    expect(await has(tourKey(sub, seeded.tourId))).toBe(true);
    // Already unpublished before the failure, and its purge isn't lost.
    expect(await has(pubTourKey(seeded.tourId))).toBe(false);
    expect(partial.purge.files).toContain(pubTourKey(seeded.tourId));

    const later = new Date('2026-10-21T03:17:00.000Z');
    const purge = await sweepAccountDeletions(depsWith(), later);
    for (const key of everyKey(sub, seeded)) expect(await has(key)).toBe(false);
    expect(await has(deletingKey(sub, 'acct-resume-tomb'))).toBe(false);
    expect(await statsOf(seeded.tourId)).toEqual({ views: 0, likes: 0 });
    expect(purge.prefixes).toContain(`tiles/${seeded.panoId}/`);
    expect((await marker(sub))?.completedAt).toBe(later.toISOString());
  });
});

describe('sweepAccountDeletions', () => {
  it('catches a late upload, keeps the first completedAt, and drops the marker after the retention', async () => {
    const sub = subOf('acct-sweep');
    const done = new Date('2026-09-01T00:00:00.000Z');
    await put(accountDeletionKey(sub), {
      v: 1,
      sub,
      requestedAt: done.toISOString(),
      completedAt: done.toISOString(),
    });
    // A presigned upload that landed after the delete.
    await put(originalKey(sub, 'acct-sweep-late'), 'bytes');

    await sweepAccountDeletions(depsWith(), new Date('2026-09-02T00:00:00.000Z'));
    expect(await has(originalKey(sub, 'acct-sweep-late'))).toBe(false);
    expect((await marker(sub))?.completedAt).toBe(done.toISOString());

    const expiry = new Date(done.getTime() + ACCOUNT_MARKER_DAYS * 24 * 60 * 60 * 1000);
    await sweepAccountDeletions(depsWith(), expiry);
    expect(await marker(sub)).toBeNull();
  });

  it('skips an unreadable marker and still sweeps the others', async () => {
    await env.BUCKET.put('accounts/garbage-owner/deletion.json', 'not json');
    const sub = subOf('acct-sweep-next');
    await put(accountDeletionKey(sub), { v: 1, sub, requestedAt: '2026-10-01T00:00:00.000Z' });
    await put(originalKey(sub, 'acct-sweep-next-p'), 'bytes');

    await sweepAccountDeletions(depsWith(), new Date('2026-10-02T00:00:00.000Z'));
    expect(await has(originalKey(sub, 'acct-sweep-next-p'))).toBe(false);
    expect(await has('accounts/garbage-owner/deletion.json')).toBe(true);
    await env.BUCKET.delete('accounts/garbage-owner/deletion.json');
  });
});
