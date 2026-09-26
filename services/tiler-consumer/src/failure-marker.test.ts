import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  manifestKey,
  panoIdFromOriginalKey,
  tileFailedKeyFromOriginalKey,
} from '@internal/contracts';
import { TILER_OUTPUT_VERSION } from '@internal/tiler/version';
import { writeFailureMarker } from './failure-marker.js';

describe('writeFailureMarker', () => {
  it('writes { reason, at, originalEtag } at the sibling tile-failed key when the original exists', async () => {
    const key = 'panos/ae-_vTXvv70/p1/original';
    await env.BUCKET.put(key, 'original bytes');
    const head = await env.BUCKET.head(key);
    const before = new Date().toISOString();

    await writeFailureMarker(env.BUCKET, key, 'oversize', head!.etag);

    const marker = await env.BUCKET.get(tileFailedKeyFromOriginalKey(key));
    const body = (await marker!.json()) as { reason: string; at: string; originalEtag: string };
    expect(body.reason).toBe('oversize');
    expect(body.at >= before).toBe(true);
    expect(body.originalEtag).toBe(head!.etag);
  });

  it('also writes reason/originalEtag as customMetadata, so A2 can read them from a list() with no extra GET', async () => {
    const key = 'panos/ae-_vTXvv70/p-custom-metadata/original';
    await env.BUCKET.put(key, 'original bytes');
    const head = await env.BUCKET.head(key);

    await writeFailureMarker(env.BUCKET, key, 'oversize', head!.etag);

    const markerKey = tileFailedKeyFromOriginalKey(key);
    const listed = await env.BUCKET.list({ prefix: markerKey, include: ['customMetadata'] });
    expect(listed.objects[0]?.customMetadata).toEqual({
      reason: 'oversize',
      originalEtag: head!.etag,
    });
  });

  // Review fix: create events always carry object.eTag, so a missing one
  // can't be trusted - skip rather than fail open onto whatever's there.
  it('skips the write and logs when no expectedEtag is given', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const key = 'panos/ae-_vTXvv70/p-no-expected/original';
    await env.BUCKET.put(key, 'original bytes');

    await writeFailureMarker(env.BUCKET, key, 'dlq');

    expect(await env.BUCKET.get(tileFailedKeyFromOriginalKey(key))).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no eTag'));
    warnSpy.mockRestore();
  });

  it('a later call for the same key overwrites the reason of an earlier one', async () => {
    const key = 'panos/ae-_vTXvv70/p-overwrite/original';
    await env.BUCKET.put(key, 'original bytes');
    const head = await env.BUCKET.head(key);

    await writeFailureMarker(env.BUCKET, key, 'unprocessable-key', head!.etag);
    await writeFailureMarker(env.BUCKET, key, 'dlq', head!.etag);

    const marker = await env.BUCKET.get(tileFailedKeyFromOriginalKey(key));
    const body = (await marker!.json()) as { reason: string };
    expect(body.reason).toBe('dlq');
  });

  describe('redelivery updates `at` rather than leaving it stale', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a second write for the same key advances `at`', async () => {
      const key = 'panos/ae-_vTXvv70/p-redelivered/original';
      await env.BUCKET.put(key, 'original bytes');
      const head = await env.BUCKET.head(key);

      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await writeFailureMarker(env.BUCKET, key, 'dlq', head!.etag);
      vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'));
      await writeFailureMarker(env.BUCKET, key, 'dlq', head!.etag);

      const marker = await env.BUCKET.get(tileFailedKeyFromOriginalKey(key));
      const body = (await marker!.json()) as { at: string };
      expect(body.at).toBe('2026-01-01T00:00:10.000Z');

      const list = await env.BUCKET.list({ prefix: tileFailedKeyFromOriginalKey(key) });
      expect(list.objects).toHaveLength(1);
    });
  });

  it('throws no further and writes nothing for a key with no owner/panoId to hang a marker off', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const key = 'panos/only-one-segment/original';

    await expect(writeFailureMarker(env.BUCKET, key, 'unprocessable-key')).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] as [string];
    expect(message).toContain(key);
    warnSpy.mockRestore();
  });

  // Review fix: keys.ts now validates both segments' charset, so an invalid
  // one throws there and this never reaches the R2 calls at all.
  it('logs and writes nothing for a panoId with an invalid charset', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const key = 'panos/ae-_vTXvv70/bad panoid/original';

    await writeFailureMarker(env.BUCKET, key, 'unprocessable-key');

    expect(await env.BUCKET.get('panos/ae-_vTXvv70/bad panoid/tile-failed')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot derive'));
    warnSpy.mockRestore();
  });

  describe('resurrection guard (review blocker)', () => {
    it('skips the write and logs when the original no longer exists', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      // Deliberately never put() this key - simulates deletePano's sweep
      // having already run before this (slow, retried) marker write lands.
      const key = 'panos/ae-_vTXvv70/p-already-deleted/original';

      await writeFailureMarker(env.BUCKET, key, 'dlq', 'whatever-etag');

      expect(await env.BUCKET.get(tileFailedKeyFromOriginalKey(key))).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no longer exists'));
      warnSpy.mockRestore();
    });

    it('skips the write and logs when the original etag no longer matches (superseded by a newer upload)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const key = 'panos/ae-_vTXvv70/p-superseded/original';
      await env.BUCKET.put(key, 'newer bytes');

      await writeFailureMarker(env.BUCKET, key, 'dlq', '"stale-etag-from-the-old-upload"');

      expect(await env.BUCKET.get(tileFailedKeyFromOriginalKey(key))).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('etag changed'));
      warnSpy.mockRestore();
    });

    it('deletes a just-written marker if the original disappears between the pre-write HEAD and the write', async () => {
      const key = 'panos/ae-_vTXvv70/p-race/original';
      await env.BUCKET.put(key, 'original bytes');
      const expectedEtag = (await env.BUCKET.head(key))!.etag;
      const realHead = env.BUCKET.head.bind(env.BUCKET);
      const headSpy = vi.spyOn(env.BUCKET, 'head').mockImplementationOnce(async (k: string) => {
        // The pre-write HEAD sees the original; a delete lands right after -
        // simulated here as a side effect of this one-off mock.
        const before = await realHead(k);
        await env.BUCKET.delete(k);
        return before;
      });

      await writeFailureMarker(env.BUCKET, key, 'dlq', expectedEtag);

      expect(await env.BUCKET.get(tileFailedKeyFromOriginalKey(key))).toBeNull();
      headSpy.mockRestore();
    });

    it('never throws even if the write itself rejects', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const key = 'panos/ae-_vTXvv70/p-put-rejects/original';
      await env.BUCKET.put(key, 'original bytes');
      const head = await env.BUCKET.head(key);
      const putSpy = vi.spyOn(env.BUCKET, 'put').mockRejectedValue(new Error('put boom'));

      await expect(writeFailureMarker(env.BUCKET, key, 'dlq', head!.etag)).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed to write'));
      putSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('R2 errors around the HEAD calls must not escape (should-fix)', () => {
    it('a rejecting pre-write HEAD skips the write and logs, without throwing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const key = 'panos/ae-_vTXvv70/p-head-rejects/original';
      await env.BUCKET.put(key, 'original bytes');
      const headSpy = vi.spyOn(env.BUCKET, 'head').mockRejectedValue(new Error('head boom'));

      await expect(writeFailureMarker(env.BUCKET, key, 'dlq', 'whatever')).resolves.toBeUndefined();

      expect(await env.BUCKET.get(tileFailedKeyFromOriginalKey(key))).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('HEAD failed'));
      headSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('a rejecting post-write HEAD leaves the marker written and just logs', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const key = 'panos/ae-_vTXvv70/p-post-head-rejects/original';
      await env.BUCKET.put(key, 'original bytes');
      const head = await env.BUCKET.head(key);
      const realHead = env.BUCKET.head.bind(env.BUCKET);
      let calls = 0;
      const headSpy = vi.spyOn(env.BUCKET, 'head').mockImplementation(async (k: string) => {
        calls += 1;
        if (calls === 1) return realHead(k);
        throw new Error('post-write head boom');
      });

      await writeFailureMarker(env.BUCKET, key, 'dlq', head!.etag);

      expect(await env.BUCKET.get(tileFailedKeyFromOriginalKey(key))).not.toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not verify'));
      headSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe('same-etag race (review blocker): a concurrent attempt already tiled this exact original', () => {
    it('skips the write and logs when the manifest already reflects this original etag', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const key = 'panos/ae-_vTXvv70/p-same-etag-race/original';
      await env.BUCKET.put(key, 'original bytes');
      const head = await env.BUCKET.head(key);
      const panoId = panoIdFromOriginalKey(key);
      await env.BUCKET.put(
        manifestKey(panoId),
        JSON.stringify({ version: `t${TILER_OUTPUT_VERSION}-${head!.etag}` }),
      );

      await writeFailureMarker(env.BUCKET, key, 'dlq', head!.etag);

      expect(await env.BUCKET.get(tileFailedKeyFromOriginalKey(key))).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already tiled'));
      warnSpy.mockRestore();
    });

    it('still writes when an existing manifest reflects a different (unrelated) etag', async () => {
      const key = 'panos/ae-_vTXvv70/p-different-manifest/original';
      await env.BUCKET.put(key, 'original bytes');
      const head = await env.BUCKET.head(key);
      const panoId = panoIdFromOriginalKey(key);
      await env.BUCKET.put(
        manifestKey(panoId),
        JSON.stringify({ version: `t${TILER_OUTPUT_VERSION}-some-other-etag` }),
      );

      await writeFailureMarker(env.BUCKET, key, 'dlq', head!.etag);

      expect(await env.BUCKET.get(tileFailedKeyFromOriginalKey(key))).not.toBeNull();
    });

    it('a rejecting manifest GET does not block the write (best-effort race check)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const key = 'panos/ae-_vTXvv70/p-manifest-get-rejects/original';
      await env.BUCKET.put(key, 'original bytes');
      const head = await env.BUCKET.head(key);
      const getSpy = vi.spyOn(env.BUCKET, 'get').mockRejectedValue(new Error('get boom'));

      await writeFailureMarker(env.BUCKET, key, 'dlq', head!.etag);
      getSpy.mockRestore();

      expect(await env.BUCKET.get(tileFailedKeyFromOriginalKey(key))).not.toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not check the manifest'));
      warnSpy.mockRestore();
    });
  });
});
