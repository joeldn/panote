import {
  flagIdOf,
  FLAGS_ROOT,
  MAX_FLAG_NOTE_LENGTH,
  pubTourKey,
  type FlagRecord,
} from '@internal/contracts';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

// Storage is shared between it() cases in this file: each case flags its own tour and
// finds its flags by tourId.
const bundle = (tourId: string, panoIds: string[]) =>
  env.BUCKET.put(
    pubTourKey(tourId),
    JSON.stringify({
      v: 1,
      tourId,
      slug: `${tourId}-slug`,
      scenes: panoIds.map((panoId) => ({ panoId })),
    }),
  );
beforeAll(async () => {
  await bundle('fl-ok', ['p1', 'p2']);
  await bundle('fl-pano', ['p1']);
  await bundle('fl-bad', ['p1']);
  await bundle('fl-xo', ['p1']);
});

// Each call from its own address, so the per-IP FLAG_LIMITER (5 a minute) never trips.
let caller = 0;
const flag = (tourId: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://x/api/tours/${tourId}/flag`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': `203.0.113.${(caller += 1)}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });

const flagsOf = async (tourId: string): Promise<{ key: string; record: FlagRecord }[]> => {
  const { objects } = await env.BUCKET.list({ prefix: FLAGS_ROOT });
  const all = await Promise.all(
    objects.map(async (o) => ({
      key: o.key,
      record: (await (await env.BUCKET.get(o.key))!.json()) as FlagRecord,
    })),
  );
  return all.filter((f) => f.record.tourId === tourId);
};

describe('POST /api/tours/:tourId/flag', () => {
  it('stores a flag on a scene of the published tour, with nothing about the sender', async () => {
    const r = await flag('fl-ok', {
      panoId: 'p2',
      reason: 'sexual',
      note: '  look at the left wall  ',
    });
    expect(r.status).toBe(204);
    const [stored, ...rest] = await flagsOf('fl-ok');
    expect(rest).toEqual([]);
    expect(stored!.record).toMatchObject({
      v: 1,
      source: 'viewer',
      tourId: 'fl-ok',
      slug: 'fl-ok-slug',
      panoId: 'p2',
      reason: 'sexual',
      note: 'look at the left wall',
    });
    expect(flagIdOf(stored!.key)).toBe(stored!.record.flagId);
    expect(JSON.stringify(stored)).not.toContain('203.0.113');
    // A flag with no note stores none.
    expect((await flag('fl-ok', { panoId: 'p1', reason: 'spam' })).status).toBe(204);
    const spam = (await flagsOf('fl-ok')).find((f) => f.record.reason === 'spam');
    expect(spam?.record).not.toHaveProperty('note');
  });

  it('404s a tour that is not published, or a pano that is not one of its scenes', async () => {
    expect((await flag('fl-none', { panoId: 'p1', reason: 'hate' })).status).toBe(404);
    expect((await flag('fl-pano', { panoId: 'p9', reason: 'hate' })).status).toBe(404);
    expect(await flagsOf('fl-pano')).toEqual([]);
  });

  it('400s an unknown reason, a bad pano id or a note past the cap', async () => {
    expect((await flag('fl-bad', { panoId: 'p1', reason: 'boring' })).status).toBe(400);
    expect((await flag('fl-bad', { panoId: '../x', reason: 'spam' })).status).toBe(400);
    const long = 'x'.repeat(MAX_FLAG_NOTE_LENGTH + 1);
    expect((await flag('fl-bad', { panoId: 'p1', reason: 'other', note: long })).status).toBe(400);
    expect(await flagsOf('fl-bad')).toEqual([]);
  });

  it('refuses a cross-site browser request', async () => {
    const r = await flag(
      'fl-xo',
      { panoId: 'p1', reason: 'spam' },
      { 'Sec-Fetch-Site': 'cross-site' },
    );
    expect(r.status).toBe(403);
    expect(await flagsOf('fl-xo')).toEqual([]);
  });
});
