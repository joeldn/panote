import {
  ACCOUNT_DELETE_CONFIRMATION,
  accountDeletionKey,
  configKey,
  deletingKey,
  manifestKey,
  originalKey,
  planKey,
  publishKey,
  pubTourKey,
  encodeId,
  storedSlugKey,
  tileVersionPrefix,
  tourKey,
  uploadLogKey,
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
import { publishTour, unpublish } from './publish.js';

// Storage is shared between it() cases in this file, so each case uses its own
// subs, tourIds, panoIds and slugs.
const verify = vi.fn(async (t: string) => {
  if (t.startsWith('good:')) return { sub: `auth0|${t.slice(5)}` };
  throw new Error('bad');
});
beforeAll(() => {
  setTestJwtVerifier((t) => verify(t));
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
  // A floor-plan image: public and owner-free, so not under the owner's prefix.
  const plan = planKey(tourId, `${tag}-plan`, 'image/webp');
  await put(plan, 'img');
  await put(originalKey(sub, panoId), 'bytes');
  await put(configKey(sub, panoId), { panoId, title: 'p', hotspots: [] });
  await put(manifestKey(panoId), '{}');
  await put(`${tileVersionPrefix(panoId, 'v1')}0/0_0.webp`, 'tile');
  await view(tourId);
  // upload-api's log entry for the URL that uploaded the pano.
  const uploadLog = uploadLogKey(sub, new Date('2026-10-01T00:00:00.000Z'), panoId);
  await put(uploadLog);
  return { tourId, panoId, slug, alias, uploadLog, plan };
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
  s.uploadLog,
  s.plan,
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

    // A presign issued just before the marker logs an entry after the delete: the
    // sweep removes that too.
    const lateLog = uploadLogKey(sub, new Date('2026-09-01T00:00:01.000Z'), 'acct-sweep-log');
    await put(lateLog);
    await sweepAccountDeletions(depsWith(), new Date('2026-09-03T00:00:00.000Z'));
    expect(await has(lateLog)).toBe(false);
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

describe('a publish that slips in while the tour is being deleted', () => {
  it('is taken down again, so no bundle or slug is orphaned', async () => {
    const sub = subOf('acct-race');
    const seeded = await seedAccount(sub, 'acct-race');
    const clock = { now: new Date('2026-10-20T10:00:00.000Z'), aliasDays: 30 };
    let slipped = false;
    const deps = depsWith({
      unpublishTour: async (owner, tourId) => {
        const files = await unpublish(env.BUCKET, owner, tourId);
        // A publish queued on the TourPublisher behind this unpublish: tour.json
        // still exists, so it republishes under the same slug.
        if (!slipped) {
          slipped = true;
          const out = await publishTour(env.BUCKET, owner, tourId, { slug: seeded.slug }, clock);
          expect(out.status).toBe(200);
          expect(await has(pubTourKey(tourId))).toBe(true);
        }
        return files;
      },
    });
    await deleteAccount(deps, sub, clock.now);
    expect(slipped).toBe(true);
    expect(await has(pubTourKey(seeded.tourId))).toBe(false);
    expect(await has(storedSlugKey(seeded.slug)!)).toBe(false);
    expect(await has(publishKey(sub, seeded.tourId))).toBe(false);
    expect(await has(tourKey(sub, seeded.tourId))).toBe(false);
  });
});

describe('aliases', () => {
  it("leaves a stale alias that now belongs to another owner's tour", async () => {
    const sub = subOf('acct-alias');
    const seeded = await seedAccount(sub, 'acct-alias');
    // The old slug lapsed and another owner's tour claimed it since.
    const stale = 'acct-alias-claimed';
    await put(publishKey(sub, seeded.tourId), {
      slug: seeded.slug,
      visibility: 'public',
      publishedAt: '2026-10-01T00:00:00.000Z',
      aliases: [seeded.alias, stale],
    });
    await put(storedSlugKey(stale)!, { v: 1, kind: 'tour', tourId: 'someone-elses-tour' });

    await deleteAccount(depsWith(), sub, new Date('2026-10-20T10:00:00.000Z'));
    expect(await has(storedSlugKey(seeded.alias)!)).toBe(false);
    expect(
      (await getJson<{ tourId: string }>(env.BUCKET, storedSlugKey(stale)!))?.value.tourId,
    ).toBe('someone-elses-tour');
  });
});

describe('sweep: retention, budget and order', () => {
  const day = 24 * 60 * 60 * 1000;

  it('past retention, deletes what is left first and keeps the marker if that fails', async () => {
    const sub = subOf('acct-late30');
    const done = new Date('2026-08-01T00:00:00.000Z');
    await put(accountDeletionKey(sub), {
      v: 1,
      sub,
      requestedAt: done.toISOString(),
      completedAt: done.toISOString(),
    });
    await put(tourKey(sub, 'acct-late30-tour'), { tourId: 'acct-late30-tour', scenes: [] });
    const expiry = new Date(done.getTime() + (ACCOUNT_MARKER_DAYS + 1) * day);

    const failing = depsWith({ clearStats: vi.fn().mockRejectedValue(new Error('down')) });
    await sweepAccountDeletions(failing, expiry);
    expect(await marker(sub)).not.toBeNull();

    await sweepAccountDeletions(depsWith(), expiry);
    expect(await has(tourKey(sub, 'acct-late30-tour'))).toBe(false);
    expect(await marker(sub)).toBeNull();
  });

  it('caps each account, so a big one cannot starve the next', async () => {
    const big = subOf('acct-big');
    const small = subOf('acct-small');
    // big was requested first, so it goes first.
    await put(accountDeletionKey(big), { v: 1, sub: big, requestedAt: '2026-01-01T00:00:00.000Z' });
    await put(accountDeletionKey(small), {
      v: 1,
      sub: small,
      requestedAt: '2026-01-02T00:00:00.000Z',
    });
    for (const n of [1, 2, 3]) await put(originalKey(big, `acct-big-p${n}`), 'bytes');
    await put(originalKey(small, 'acct-small-p1'), 'bytes');

    const now = new Date('2026-10-20T03:17:00.000Z');
    await sweepAccountDeletions(depsWith(), now, { items: 100 }, 2);
    const bigLeft = await env.BUCKET.list({ prefix: `panos/${encodeId(big)}/` });
    expect(bigLeft.objects).toHaveLength(1);
    expect((await marker(big))?.completedAt).toBeUndefined();
    expect(await has(originalKey(small, 'acct-small-p1'))).toBe(false);
    expect((await marker(small))?.completedAt).toBe(now.toISOString());

    await sweepAccountDeletions(depsWith(), now, { items: 100 }, 2);
    expect((await env.BUCKET.list({ prefix: `panos/${encodeId(big)}/` })).objects).toHaveLength(0);
    expect((await marker(big))?.completedAt).toBe(now.toISOString());
  });

  it('stops at the run budget and leaves the rest for the next run', async () => {
    const sub = subOf('acct-budget');
    await put(accountDeletionKey(sub), { v: 1, sub, requestedAt: '2026-10-19T00:00:00.000Z' });
    for (const n of [1, 2]) await put(originalKey(sub, `acct-budget-p${n}`), 'bytes');
    await sweepAccountDeletions(depsWith(), new Date('2026-10-20T00:00:00.000Z'), { items: 0 });
    expect((await env.BUCKET.list({ prefix: `panos/${encodeId(sub)}/` })).objects).toHaveLength(2);
    expect((await marker(sub))?.completedAt).toBeUndefined();
  });

  it('only LISTs a finished, still-empty account', async () => {
    const sub = subOf('acct-cheap');
    const at = '2026-10-19T00:00:00.000Z';
    await put(accountDeletionKey(sub), { v: 1, sub, requestedAt: at, completedAt: at });
    const owner = encodeId(sub);
    const listed: { prefix?: string; delimiter?: string; limit?: number }[] = [];
    const bucket = new Proxy(env.BUCKET, {
      get(target, prop) {
        if (prop === 'list') {
          return (opts: R2ListOptions) => {
            if (opts.prefix?.includes(owner)) listed.push(opts);
            return target.list(opts);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const clearStats = vi.fn(async () => {});
    await sweepAccountDeletions(
      depsWith({ bucket, clearStats }),
      new Date('2026-10-20T00:00:00.000Z'),
    );
    expect(listed.every((o) => o.limit === 1 && o.delimiter === undefined)).toBe(true);
    // tours/, panos/ and upload-log/.
    expect(listed).toHaveLength(3);
    expect(await marker(sub)).not.toBeNull();
  });

  it("skips a marker whose sub isn't its own key", async () => {
    const victim = subOf('acct-victim');
    await put(originalKey(victim, 'acct-victim-p'), 'bytes');
    await put('accounts/not-the-victim/deletion.json', {
      v: 1,
      sub: victim,
      requestedAt: '2026-10-19T00:00:00.000Z',
    });
    await sweepAccountDeletions(depsWith(), new Date('2026-10-20T00:00:00.000Z'));
    expect(await has(originalKey(victim, 'acct-victim-p'))).toBe(true);
    await env.BUCKET.delete('accounts/not-the-victim/deletion.json');
  });
});

describe('write gate', () => {
  it('verifies the JWT once per write', async () => {
    verify.mockClear();
    const r = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: bearer('acct-once'),
      body: JSON.stringify({ title: 'Once', scenes: [] }),
    });
    expect(r.status).toBe(201);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe('sweep: run budget across accounts, and order', () => {
  const now = new Date('2026-10-20T03:17:00.000Z');
  const panosLeft = async (sub: string) =>
    (await env.BUCKET.list({ prefix: `panos/${encodeId(sub)}/` })).objects.length;

  it('counts the run budget down across accounts until it is spent', async () => {
    const subs = [1, 2, 3].map((n) => subOf(`acct-glob-${n}`));
    for (const [i, sub] of subs.entries()) {
      await put(accountDeletionKey(sub), {
        v: 1,
        sub,
        requestedAt: `2025-01-0${i + 1}T00:00:00.000Z`,
      });
      for (const n of [1, 2]) await put(originalKey(sub, `acct-glob-${i + 1}-p${n}`), 'bytes');
    }
    // Three items for the run, ten per account: the first takes 2, the second 1, the third none.
    await sweepAccountDeletions(depsWith(), now, { items: 3 }, 10);
    expect(await Promise.all(subs.map(panosLeft))).toEqual([0, 1, 2]);
    expect((await marker(subs[0]!))?.completedAt).toBe(now.toISOString());
    expect((await marker(subs[1]!))?.completedAt).toBeUndefined();
    expect((await marker(subs[2]!))?.completedAt).toBeUndefined();
  });

  it('works on interrupted deletes before finished ones', async () => {
    // The finished account sorts first both by key and by requestedAt.
    const finished = subOf('acct-order-done');
    const interrupted = subOf('acct-order-open');
    expect(accountDeletionKey(finished) < accountDeletionKey(interrupted)).toBe(true);
    await put(accountDeletionKey(finished), {
      v: 1,
      sub: finished,
      requestedAt: '2024-01-01T00:00:00.000Z',
      completedAt: '2024-01-01T00:00:00.000Z',
    });
    await put(accountDeletionKey(interrupted), {
      v: 1,
      sub: interrupted,
      requestedAt: '2024-02-01T00:00:00.000Z',
    });
    await put(originalKey(finished, 'acct-order-done-late'), 'bytes');
    await put(originalKey(interrupted, 'acct-order-open-p'), 'bytes');

    await sweepAccountDeletions(depsWith(), now, { items: 1 }, 10);
    expect(await panosLeft(interrupted)).toBe(0);
    expect(await panosLeft(finished)).toBe(1);
  });
});
