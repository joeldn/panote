import {
  accountDeletionKey,
  accountDisabledKey,
  configKey,
  manifestKey,
  OPERATOR_TAKEDOWN_PATH,
  OPERATOR_TOKEN_HEADER,
  originalKey,
  publishKey,
  pubTourKey,
  storedSlugKey,
  tourKey,
  tourOwnerKey,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { sweepAccountDeletions } from './delete-account.js';
import worker from './index.js';
import { isOperator, recordTourOwner } from './operator.js';
import { unpublish } from './publish.js';

// Storage is shared between it() cases in this file, so each case uses its own
// subs, tourIds, panoIds and slugs.
beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t.startsWith('good:')) return { sub: `auth0|${t.slice(5)}` };
    throw new Error('bad');
  });
});

const TOKEN = 'test-operator-token';
const subOf = (who: string) => `auth0|${who}`;
const bearer = (who: string) => ({ Authorization: `Bearer good:${who}` });
const put = (key: string, value: unknown = '') =>
  env.BUCKET.put(key, typeof value === 'string' ? value : JSON.stringify(value));
const has = async (key: string) => !!(await env.BUCKET.head(key));

/** A published tour with a live slug and one pano only it uses. */
const seedTour = async (sub: string, tag: string) => {
  const tourId = `${tag}-tour`;
  const panoId = `${tag}-pano`;
  const slug = `${tag}-live`;
  await put(tourKey(sub, tourId), { tourId, title: 't', scenes: [{ panoId }] });
  await put(publishKey(sub, tourId), {
    slug,
    visibility: 'public',
    publishedAt: '2026-10-01T00:00:00.000Z',
  });
  await put(storedSlugKey(slug)!, { v: 1, kind: 'tour', tourId });
  await put(pubTourKey(tourId), { v: 1, tourId });
  await put(originalKey(sub, panoId), 'bytes');
  await put(configKey(sub, panoId), { panoId, title: 'p', hotspots: [] });
  return { tourId, panoId, slug };
};

const takedown = (body: unknown, token: string | null = TOKEN) =>
  SELF.fetch(`https://x${OPERATOR_TAKEDOWN_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { [OPERATOR_TOKEN_HEADER]: token }),
    },
    body: JSON.stringify(body),
  });

describe('POST /api/admin/operator/takedown', () => {
  it('unpublish takes the share link, bundle and slug down and keeps the tour', async () => {
    const sub = subOf('op-unpub');
    const s = await seedTour(sub, 'op-unpub');
    const r = await takedown({ sub, tourId: s.tourId, action: 'unpublish' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ action: 'unpublish', purged: 2 });
    expect(await has(pubTourKey(s.tourId))).toBe(false);
    expect(await has(storedSlugKey(s.slug)!)).toBe(false);
    expect(await has(publishKey(sub, s.tourId))).toBe(false);
    expect(await has(tourKey(sub, s.tourId))).toBe(true);
    expect(await has(originalKey(sub, s.panoId))).toBe(true);
  });

  it('logs an audit line naming the action and the tour, never the owner', async () => {
    const sub = subOf('op-audit');
    const s = await seedTour(sub, 'op-audit');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await takedown({ sub, tourId: s.tourId, action: 'unpublish' })).status).toBe(200);
      const lines = warn.mock.calls.map((args) => args.join(' '));
      expect(lines).toContain(`[takedown] operator unpublish of tour ${s.tourId} done`);
      expect(lines.join('\n')).not.toContain(sub);
    } finally {
      warn.mockRestore();
    }
  });

  it('delete removes the tour and the panos only it used, unpublishing first', async () => {
    const sub = subOf('op-del');
    const s = await seedTour(sub, 'op-del');
    const r = await takedown({ sub, tourId: s.tourId, action: 'delete' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ action: 'delete' });
    for (const key of [
      pubTourKey(s.tourId),
      storedSlugKey(s.slug)!,
      publishKey(sub, s.tourId),
      tourKey(sub, s.tourId),
      originalKey(sub, s.panoId),
    ]) {
      expect([key, await has(key)]).toEqual([key, false]);
    }
  });

  it('works on an owner whose writes are blocked, and needs no Auth0 user', async () => {
    const sub = subOf('op-blocked');
    const s = await seedTour(sub, 'op-blocked');
    await put(accountDisabledKey(sub), { v: 1, disabledAt: '2026-10-20T00:00:00.000Z' });
    const r = await takedown({ sub, tourId: s.tourId, action: 'unpublish' });
    expect(r.status).toBe(200);
    expect(await has(pubTourKey(s.tourId))).toBe(false);
  });

  it("404s a tour the named owner doesn't have, and touches nothing", async () => {
    const s = await seedTour(subOf('op-real-owner'), 'op-wrong-owner');
    const r = await takedown({ sub: subOf('op-not-owner'), tourId: s.tourId, action: 'delete' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'tour not found' });
    expect(await has(pubTourKey(s.tourId))).toBe(true);
  });

  it.each([
    ['no token', null],
    ['a wrong token', 'nope'],
    ['a token with a different length', `${TOKEN}x`],
    ['an empty token', ''],
  ])('404s with %s and touches nothing', async (_label, token) => {
    const sub = subOf(`op-guard-${String(token).length}`);
    const s = await seedTour(sub, `op-guard-${String(token).length}`);
    const r = await takedown({ sub, tourId: s.tourId, action: 'delete' }, token);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not found' });
    expect(await has(tourKey(sub, s.tourId))).toBe(true);
  });

  it('is a 404 when OPERATOR_TOKEN is not set in the env, even with a token', async () => {
    const sub = subOf('op-unset');
    const s = await seedTour(sub, 'op-unset');
    const { OPERATOR_TOKEN: _unset, ...withoutToken } = env;
    const ctx = createExecutionContext();
    const r = await worker.fetch(
      new Request(`https://x${OPERATOR_TAKEDOWN_PATH}`, {
        method: 'POST',
        headers: { [OPERATOR_TOKEN_HEADER]: TOKEN },
        body: JSON.stringify({ sub, tourId: s.tourId, action: 'delete' }),
      }),
      withoutToken,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(404);
    expect(await has(tourKey(sub, s.tourId))).toBe(true);
  });

  it('400s a body that fails the schema', async () => {
    const r = await takedown({ sub: subOf('op-bad'), tourId: 'a/b', action: 'unpublish' });
    expect(r.status).toBe(400);
  });

  it('a JWT is not a way in', async () => {
    const r = await SELF.fetch(`https://x${OPERATOR_TAKEDOWN_PATH}`, {
      method: 'POST',
      headers: bearer('op-jwt'),
      body: JSON.stringify({ sub: subOf('op-jwt'), tourId: 'x', action: 'unpublish' }),
    });
    expect(r.status).toBe(404);
  });
});

describe('isOperator', () => {
  it('needs a non-blank secret and the same value presented', async () => {
    expect(await isOperator('s3cret', 's3cret')).toBe(true);
    expect(await isOperator('s3cret', 's3cre')).toBe(false);
    expect(await isOperator('s3cret', undefined)).toBe(false);
    expect(await isOperator(undefined, 's3cret')).toBe(false);
    expect(await isOperator('  ', '  ')).toBe(false);
  });
});

describe('a disabled owner', () => {
  const disable = (sub: string) =>
    put(accountDisabledKey(sub), { v: 1, disabledAt: '2026-10-20T00:00:00.000Z' });

  it('gets 403 on every write and can still read', async () => {
    const who = 'op-disabled';
    const s = await seedTour(subOf(who), who);
    await disable(subOf(who));
    const writes: [string, string][] = [
      ['POST', '/api/admin/tours'],
      ['PUT', `/api/admin/panos/${s.panoId}/config`],
      ['PUT', `/api/admin/tours/${s.tourId}`],
      ['DELETE', `/api/admin/panos/${s.panoId}`],
      ['POST', `/api/admin/tours/${s.tourId}/publish`],
      ['PUT', `/api/admin/tours/${s.tourId}/slug`],
      ['PATCH', `/api/admin/tours/${s.tourId}/visibility`],
      ['DELETE', `/api/admin/tours/${s.tourId}/publish`],
    ];
    for (const [method, path] of writes) {
      const r = await SELF.fetch(`https://x${path}`, {
        method,
        headers: { ...bearer(who), 'If-Match': '*' },
        body: '{}',
      });
      expect([method, path, r.status]).toEqual([method, path, 403]);
      expect(await r.json()).toEqual({ error: 'account disabled' });
    }
    expect(await has(pubTourKey(s.tourId))).toBe(true);
    const list = await SELF.fetch('https://x/api/admin/tours', { headers: bearer(who) });
    expect(list.status).toBe(200);
  });

  it('may still delete their own account', async () => {
    const who = 'op-disabled-deletes';
    await seedTour(subOf(who), who);
    await disable(subOf(who));
    const r = await SELF.fetch('https://x/api/admin/account', {
      method: 'DELETE',
      headers: { ...bearer(who), 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'delete my account' }),
    });
    expect(r.status).toBe(200);
    // The takedown outlives the deletion, so the same sign-in stays blocked.
    expect(await has(accountDisabledKey(subOf(who)))).toBe(true);
  });

  it('a deleted and disabled account answers 410, the deletion first', async () => {
    const who = 'op-both';
    await disable(subOf(who));
    await put(accountDeletionKey(subOf(who)), {
      v: 1,
      sub: subOf(who),
      requestedAt: '2026-10-20T00:00:00.000Z',
    });
    const r = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: bearer(who),
      body: '{}',
    });
    expect(r.status).toBe(410);
  });

  it("doesn't block another owner", async () => {
    await disable(subOf('op-disabled-other'));
    const r = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: bearer('op-not-disabled'),
      body: JSON.stringify({ title: 'Fine', scenes: [] }),
    });
    expect(r.status).toBe(201);
  });

  it("the account-deletion sweep doesn't read the disabled marker as a deletion", async () => {
    const sub = subOf('op-sweep-skip');
    await disable(sub);
    await put(originalKey(sub, 'op-sweep-skip-p'), 'bytes');
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      await sweepAccountDeletions(
        {
          bucket: env.BUCKET,
          unpublishTour: (s, t) => unpublish(env.BUCKET, s, t),
          clearStats: async () => {},
        },
        new Date('2026-10-20T00:00:00.000Z'),
      );
    } finally {
      console.error = original;
    }
    expect(errors.flat().join(' ')).not.toContain('unreadable or misfiled');
    expect(await has(originalKey(sub, 'op-sweep-skip-p'))).toBe(true);
  });
});

describe('the tour owner pointer (tourOwnerKey)', () => {
  const pointer = async (tourId: string) => {
    const obj = await env.BUCKET.get(tourOwnerKey(tourId));
    return obj ? await obj.json() : null;
  };

  it('is written when a tour is created', async () => {
    const who = 'ptr-create';
    const r = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: bearer(who),
      body: JSON.stringify({ title: 'T', scenes: [] }),
    });
    expect(r.status).toBe(201);
    const { tourId } = (await r.json()) as { tourId: string };
    expect(await pointer(tourId)).toEqual({ v: 1, sub: subOf(who) });
  });

  it('is written when an older tour without one is published, and not by a failed publish', async () => {
    const who = 'ptr-publish';
    const tourId = 'ptr-publish-tour';
    const panoId = 'ptr-publish-pano';
    await put(tourKey(subOf(who), tourId), { tourId, title: 'Legacy', scenes: [{ panoId }] });
    await put(originalKey(subOf(who), panoId), 'bytes');
    await put(configKey(subOf(who), panoId), { panoId, title: 'p', hotspots: [] });
    await put(manifestKey(panoId), { pano: panoId });
    const failed = await SELF.fetch(`https://x/api/admin/tours/${tourId}/publish`, {
      method: 'POST',
      headers: bearer('ptr-someone-else'),
      body: '{}',
    });
    expect(failed.status).toBe(404);
    expect(await pointer(tourId)).toBeNull();
    const r = await SELF.fetch(`https://x/api/admin/tours/${tourId}/publish`, {
      method: 'POST',
      headers: bearer(who),
      body: '{}',
    });
    expect(r.status).toBe(200);
    expect(await pointer(tourId)).toEqual({ v: 1, sub: subOf(who) });
  });

  it('a failed pointer write only logs, without the owner, and never throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = {
      put: async () => {
        throw new Error(`R2 PUT tour-owners/x.json for ${subOf('ptr-fails')} -> 500`);
      },
    } as unknown as R2Bucket;
    try {
      await expect(recordTourOwner(failing, subOf('ptr-fails'), 'ptr-fails-tour')).resolves.toBe(
        undefined,
      );
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.mock.calls)).not.toContain('ptr-fails|');
      expect(JSON.stringify(error.mock.calls)).not.toContain(subOf('ptr-fails'));
    } finally {
      error.mockRestore();
    }
  });

  it('goes with the tour on an operator delete and on an account delete', async () => {
    const sub = subOf('ptr-del');
    const s = await seedTour(sub, 'ptr-del');
    await put(tourOwnerKey(s.tourId), { v: 1, sub });
    expect((await takedown({ sub, tourId: s.tourId, action: 'delete' })).status).toBe(200);
    expect(await has(tourOwnerKey(s.tourId))).toBe(false);

    const who = 'ptr-account';
    const t = await seedTour(subOf(who), who);
    await put(tourOwnerKey(t.tourId), { v: 1, sub: subOf(who) });
    const r = await SELF.fetch('https://x/api/admin/account', {
      method: 'DELETE',
      headers: { ...bearer(who), 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'delete my account' }),
    });
    expect(r.status).toBe(200);
    expect(await has(tourOwnerKey(t.tourId))).toBe(false);
  });
});
