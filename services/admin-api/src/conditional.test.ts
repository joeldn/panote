import { WorkerError } from '@internal/worker-kit';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { conditionalGet, guardedPut, updateConditional, type HeadAndPut } from './conditional.js';

describe('updateConditional', () => {
  it('throws (428) when If-Match is missing', () => {
    expect(() => updateConditional(undefined)).toThrow();
  });

  it('treats a bare * as unconditional', () => {
    expect(updateConditional('*')).toBeUndefined();
  });

  it('strips quotes from a strong etag', () => {
    expect(updateConditional('"abc123"')).toEqual({ etagMatches: 'abc123' });
  });

  it('strips a weak W/ prefix as well as quotes', () => {
    expect(updateConditional('W/"abc123"')).toEqual({ etagMatches: 'abc123' });
  });

  it('treats "x*y" as a literal (mismatching) tag, not a wildcard', () => {
    expect(updateConditional('x*y')).toEqual({ etagMatches: 'x*y' });
  });

  it('412s directly for a bare token containing a quote, rather than handing R2 a guessed etag', () => {
    let thrown: unknown;
    try {
      updateConditional('"');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(WorkerError);
    expect((thrown as WorkerError).status).toBe(412);
    // Same body as the normal conflict response, so callers can't tell the
    // two 412 paths apart.
    expect((thrown as WorkerError).message).toBe('conflict');
  });

  it('never reaches the bucket for a bare-quote If-Match: it throws before any put is attempted', () => {
    let putCalled = false;
    const spyBucket: HeadAndPut = {
      head: async () => null,
      put: async () => {
        putCalled = true;
        throw new Error('put should never be called');
      },
    };
    expect(() => {
      const onlyIf = updateConditional('"'); // throws (412) before this line returns
      void guardedPut(spyBucket, 'unreachable', {}, onlyIf);
    }).toThrow();
    expect(putCalled).toBe(false);
  });

  it('400s a multi-tag If-Match instead of silently using the first tag', () => {
    expect(() => updateConditional('"a", "b"')).toThrow(/single etag/);
  });
});

// env.BUCKET.put()'s ambient type is nullable (R2's onlyIf-failure overload),
// even though an unconditional put here always succeeds.
const putEtag = async (key: string, value: string): Promise<string> => {
  const obj = await env.BUCKET.put(key, value);
  if (!obj) throw new Error('unconditional put unexpectedly failed');
  return obj.etag;
};

describe('conditionalGet', () => {
  it('reads unconditionally when If-None-Match is absent', async () => {
    await env.BUCKET.put('cond/plain', 'x');
    const result = await conditionalGet(env.BUCKET, 'cond/plain', undefined);
    expect(result?.notModified).toBe(false);
  });

  it('returns null for a missing key regardless of If-None-Match', async () => {
    const result = await conditionalGet(env.BUCKET, 'cond/missing', '*');
    expect(result).toBeNull();
  });

  it('is not modified on a matching strong etag', async () => {
    const etag = await putEtag('cond/strong', 'x');
    const result = await conditionalGet(env.BUCKET, 'cond/strong', `"${etag}"`);
    expect(result).toEqual({ notModified: true, etag });
  });

  it('is not modified on a matching weak (W/) etag', async () => {
    const etag = await putEtag('cond/weak', 'x');
    const result = await conditionalGet(env.BUCKET, 'cond/weak', `W/"${etag}"`);
    expect(result).toEqual({ notModified: true, etag });
  });

  it('is not modified when the matching etag is first in a comma list', async () => {
    const etag = await putEtag('cond/list-first', 'x');
    const result = await conditionalGet(env.BUCKET, 'cond/list-first', `"${etag}", "other"`);
    expect(result?.notModified).toBe(true);
  });

  it('is not modified when the matching etag is last in a comma list', async () => {
    const etag = await putEtag('cond/list-last', 'x');
    const result = await conditionalGet(env.BUCKET, 'cond/list-last', `"other", "${etag}"`);
    expect(result?.notModified).toBe(true);
  });

  it('is modified (200) on a non-matching If-None-Match', async () => {
    await env.BUCKET.put('cond/mismatch', 'x');
    const result = await conditionalGet(env.BUCKET, 'cond/mismatch', '"nonsense"');
    expect(result?.notModified).toBe(false);
  });

  it('treats If-None-Match: * as matching any existing object', async () => {
    await env.BUCKET.put('cond/wildcard', 'x');
    const result = await conditionalGet(env.BUCKET, 'cond/wildcard', '*');
    expect(result?.notModified).toBe(true);
  });

  it('treats "x*y" as a literal (mismatching) tag, not a wildcard', async () => {
    await env.BUCKET.put('cond/star-in-tag', 'x');
    const result = await conditionalGet(env.BUCKET, 'cond/star-in-tag', 'x*y');
    expect(result?.notModified).toBe(false);
  });

  it('treats a bare token containing a quote as "no match" rather than erroring', async () => {
    await env.BUCKET.put('cond/quote', 'x');
    const result = await conditionalGet(env.BUCKET, 'cond/quote', '"');
    expect(result?.notModified).toBe(false);
  });
});

describe('guardedPut', () => {
  const tourJson = (tourId: string, title: string) => JSON.stringify({ tourId, title, scenes: [] });

  it('404s a key that has never existed', async () => {
    const result = await guardedPut(env.BUCKET, 'guarded/never-existed', {}, undefined);
    expect(result).toEqual({ ok: false, status: 404 });
  });

  it('creates nothing on that 404 (no create-on-missing)', async () => {
    await guardedPut(env.BUCKET, 'guarded/never-existed-2', {}, undefined);
    expect(await env.BUCKET.get('guarded/never-existed-2')).toBeNull();
  });

  it('a wildcard put succeeds and is pinned to the etag it just read', async () => {
    const key = 'guarded/wildcard-ok';
    await env.BUCKET.put(key, tourJson('t1', 'Original'));
    const result = await guardedPut(
      env.BUCKET,
      key,
      { tourId: 't1', title: 'New', scenes: [] },
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it('a write landing between head() and put() 412s rather than clobbering it', async () => {
    const key = 'guarded/race-write';
    await env.BUCKET.put(key, tourJson('t2', 'Original'));
    // Captured before the interloping write below, so the head() guardedPut
    // uses internally is deliberately stale - the real race window.
    const staleHead = await env.BUCKET.head(key);
    await env.BUCKET.put(key, tourJson('t2', 'Interloper'));

    const staleHeadBucket: HeadAndPut = {
      head: async () => staleHead,
      put: (k, v, options) => env.BUCKET.put(k, v, options),
    };
    const result = await guardedPut(
      staleHeadBucket,
      key,
      { tourId: 't2', title: 'Mine', scenes: [] },
      undefined,
    );
    expect(result).toEqual({ ok: false, status: 412 });
    const stored = JSON.parse((await (await env.BUCKET.get(key))?.text()) ?? 'null');
    expect(stored?.title).toBe('Interloper');
  });

  it('a delete landing between head() and put() 412s rather than resurrecting the key', async () => {
    const key = 'guarded/race-delete';
    await env.BUCKET.put(key, tourJson('t3', 'Original'));
    const staleHead = await env.BUCKET.head(key);
    await env.BUCKET.delete(key);

    const staleHeadBucket: HeadAndPut = {
      head: async () => staleHead,
      put: (k, v, options) => env.BUCKET.put(k, v, options),
    };
    const result = await guardedPut(
      staleHeadBucket,
      key,
      { tourId: 't3', title: 'Resurrected', scenes: [] },
      undefined,
    );
    expect(result).toEqual({ ok: false, status: 412 });
    expect(await env.BUCKET.get(key)).toBeNull();
  });
});
