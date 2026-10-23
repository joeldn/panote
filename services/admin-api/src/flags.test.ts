import {
  FLAGS_PATH,
  FLAGS_ROOT,
  flagKey,
  type FlagList,
  type FlagRecord,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The queue is one list, so each case starts from an empty moderation/flags/.
beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    const [kind = '', who = ''] = t.split(':');
    const now = Math.floor(Date.now() / 1000);
    if (kind === 'good') return { sub: `auth0|${who}`, authTime: now };
    if (kind === 'stale') return { sub: `auth0|${who}`, authTime: now - 24 * 60 * 60 };
    throw new Error('bad');
  });
});
beforeEach(async () => {
  const { objects } = await env.BUCKET.list({ prefix: FLAGS_ROOT });
  if (objects.length) await env.BUCKET.delete(objects.map((o) => o.key));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const T0 = Date.parse('2026-10-20T00:00:00.000Z');
const seed = async (flagId: string, minutes: number, over: Partial<FlagRecord> = {}) => {
  const at = T0 + minutes * 60_000;
  const record: FlagRecord = {
    v: 1,
    flagId,
    source: 'viewer',
    tourId: 't1',
    slug: 'old-town',
    panoId: 'p1',
    reason: 'spam',
    at: new Date(at).toISOString(),
    ...over,
  };
  await env.BUCKET.put(flagKey(at, flagId), JSON.stringify(record));
  return record;
};

const get = (token = 'good:operator') =>
  SELF.fetch(`https://x${FLAGS_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
const dismiss = (flagIds: unknown, token = 'good:operator') =>
  SELF.fetch(`https://x${FLAGS_PATH}/dismiss`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ flagIds }),
  });

describe('operator flags', () => {
  it('lists the newest first and drops what does not parse or is misfiled', async () => {
    await seed('old', 1);
    await seed('new', 3, { reason: 'sexual', note: 'left wall' });
    await env.BUCKET.put(flagKey(T0 + 2 * 60_000, 'junk'), 'not json');
    await seed('misfiled', 4, { flagId: 'someone-else' });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await r.json()) as FlagList;
    expect(body.flags.map((f) => f.flagId)).toEqual(['new', 'old']);
    expect(body.flags[0]).toMatchObject({ reason: 'sexual', note: 'left wall' });
    expect(body.more).toBe(false);
  });

  it('dismisses the named flags and answers the list as it is now', async () => {
    await seed('a', 1);
    await seed('b', 2);
    await seed('c', 3);
    const r = await dismiss(['a', 'c', 'never-was']);
    expect(r.status).toBe(200);
    expect(((await r.json()) as FlagList).flags.map((f) => f.flagId)).toEqual(['b']);
  });

  it('is a 404 for anyone but an operator, and dismiss wants a recent sign-in and ids', async () => {
    await seed('kept', 1);
    expect((await get('good:someone')).status).toBe(404);
    expect((await dismiss(['kept'], 'good:someone')).status).toBe(404);
    expect((await dismiss(['kept'], 'stale:operator')).status).toBe(403);
    expect((await dismiss([])).status).toBe(400);
    expect((await dismiss(['../x'])).status).toBe(400);
    expect(((await (await get()).json()) as FlagList).flags.map((f) => f.flagId)).toEqual(['kept']);
  });
});
