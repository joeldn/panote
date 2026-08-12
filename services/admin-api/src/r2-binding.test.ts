// This is crud-worker/src/r2.test.ts, retargeted at @internal/worker-kit's
// r2-binding module. It lives in this package rather than in @internal/worker-kit
// because it needs a live R2Bucket - workerd, not Node - and admin-api is the
// only package in the wave with a BUCKET binding (see the port spec section 4.5).
//
// Each case uses its own key namespace and creates whatever it asserts on (port
// spec section 0.7): storage is shared between it() cases in one file but
// isolated between files, and the isolatedStorage:false option that used to
// paper over cross-file ordering no longer exists.
import { deletePrefix, getJson, listChildren, putJson } from '@internal/worker-kit/r2-binding';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const CREATE_ONLY = { etagDoesNotMatch: '*' } as const;

describe('r2-binding', () => {
  it('creates only when absent, then conflicts', async () => {
    const key = 'panos/u-create/p1/config.json';
    const a = await putJson(env.BUCKET, key, { x: 1 }, CREATE_ONLY);
    expect(a.ok).toBe(true);
    const b = await putJson(env.BUCKET, key, { x: 2 }, CREATE_ONLY);
    expect(b).toEqual({ ok: false, conflict: true });
  });

  it('updates on a matching etag and conflicts on a stale one', async () => {
    const key = 'panos/u-etag/p1/config.json';
    const created = await putJson(env.BUCKET, key, { v: 1 }, CREATE_ONLY);
    expect(created.ok).toBe(true);
    const etag = created.ok ? created.etag : '';
    const ok = await putJson(env.BUCKET, key, { v: 2 }, { etagMatches: etag });
    expect(ok.ok).toBe(true);
    const stale = await putJson(env.BUCKET, key, { v: 3 }, { etagMatches: etag /* now stale */ });
    expect(stale).toEqual({ ok: false, conflict: true });
  });

  it('overwrites unconditionally when no precondition is given', async () => {
    const key = 'panos/u-overwrite/p1/config.json';
    await putJson(env.BUCKET, key, { v: 1 }, CREATE_ONLY);
    const res = await putJson(env.BUCKET, key, { v: 2 });
    expect(res.ok).toBe(true);
    const got = await getJson<{ v: number }>(env.BUCKET, key);
    expect(got?.value.v).toBe(2);
  });

  it('round-trips and lists children', async () => {
    await putJson(env.BUCKET, 'panos/u-list/p1/config.json', { y: 1 }, CREATE_ONLY);
    await putJson(env.BUCKET, 'panos/u-list/p2/config.json', { y: 9 }, CREATE_ONLY);
    const got = await getJson<{ y: number }>(env.BUCKET, 'panos/u-list/p2/config.json');
    expect(got?.value.y).toBe(9);
    const kids = await listChildren(env.BUCKET, 'panos/u-list/');
    expect(kids).toEqual(expect.arrayContaining(['p1', 'p2']));
  });

  it('deletes a prefix', async () => {
    const prefix = 'panos/u-delete/p1/';
    const key = `${prefix}config.json`;
    await putJson(env.BUCKET, key, { x: 1 }, CREATE_ONLY);
    expect(await getJson(env.BUCKET, key)).not.toBeNull();
    await deletePrefix(env.BUCKET, prefix);
    expect(await getJson(env.BUCKET, key)).toBeNull();
  });
});
