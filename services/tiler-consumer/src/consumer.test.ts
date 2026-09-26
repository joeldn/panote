import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { tileFailedKeyFromOriginalKey } from '@internal/contracts';
import worker from './consumer.js';

/**
 * Coverage for the queue() handler's ack/retry logic - the largest untested
 * hole in the source (no consumer.test.ts existed there at all).
 *
 * Mechanical note on how these reach the handler: `createMessageBatch()`
 * requires an `attempts: number` on every message AT RUNTIME even though its
 * type does not demand it (undeclared type, degrades to `any` once
 * @cloudflare/workers-types is out of the graph), or workerd throws
 * `TypeError: Incorrect type for the 'attempts' field`. `getQueueResult()`'s
 * return also degrades to `any` for the same reason, so
 * `retryMessages`/`explicitAcks` are read structurally below rather than
 * against a named type.
 *
 * Container-reaching cases (§6.5's decision tree, approach 1): this suite
 * drives the real `env.TILER` stub - no injected "container fetcher" seam,
 * per the port spec's rule against speculative kit. That buys fidelity at
 * the cost of a coverage gap that is stated here in full rather than papered
 * over. No Docker runs in this environment (nor in CI), so under
 * @cloudflare/vitest-pool-workers 0.20.3 `ctx.container` is never populated
 * and `@cloudflare/containers`' `Container` constructor throws "Containers
 * have not been enabled for this Durable Object class" for every DO
 * instance. Every `stub.fetch()` below therefore fails rather than returning
 * a `Response`, and the ONLY ack/retry path these tests exercise is
 * `catch { msg.retry(); }`.
 *
 * The cases above only prove the message reached the container call, not
 * that any given container response is handled correctly, since
 * `stub.fetch()` never resolves without Docker.
 *
 * `describe('res.ok handling')` below closes that gap by mocking
 * `env.TILER.get` so `stub.fetch()` resolves with a response this suite
 * controls, exercising both branches for real. Whether the real container's
 * own responses are shaped correctly still needs a running image.
 */
describe('queue()', () => {
  it('acks a message whose action is not a create action, without calling the container', async () => {
    const ctx = createExecutionContext();
    const batch = createMessageBatch('pano-uploads-dev', [
      {
        id: 'msg-not-create-action',
        timestamp: new Date(),
        body: {
          object: { key: 'panos/u1/not-create/original', size: 10 },
          action: 'DeleteObject',
        },
        attempts: 1,
      },
    ]);
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['msg-not-create-action']);
    expect(result.retryMessages).toEqual([]);
  });

  it('acks a message whose key does not end in /original, without calling the container', async () => {
    const ctx = createExecutionContext();
    const batch = createMessageBatch('pano-uploads-dev', [
      {
        id: 'msg-wrong-suffix',
        timestamp: new Date(),
        body: {
          object: { key: 'panos/u1/wrong-suffix/config.json', size: 10 },
          action: 'PutObject',
        },
        attempts: 1,
      },
    ]);
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['msg-wrong-suffix']);
    expect(result.retryMessages).toEqual([]);
  });

  it('does not drop a CompleteMultipartUpload action on a */original key (startsWith filter)', async () => {
    const ctx = createExecutionContext();
    const batch = createMessageBatch('pano-uploads-dev', [
      {
        id: 'msg-multipart',
        timestamp: new Date(),
        body: {
          object: { key: 'panos/u1/multipart/original', size: 10 },
          action: 'CompleteMultipartUpload',
        },
        attempts: 1,
      },
    ]);
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    // Proof it was NOT dropped by the action/suffix filter: a filtered
    // message is acked synchronously with no container call (see the two
    // cases above). This one reaches the container-call branch instead, so
    // it is not in explicitAcks - it lands in retryMessages once the
    // container call fails in this Docker-less environment (see the file
    // header comment).
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'msg-multipart' }]);
  });

  it('does not drop a CopyObject action on a */original key (startsWith filter)', async () => {
    const ctx = createExecutionContext();
    const batch = createMessageBatch('pano-uploads-dev', [
      {
        id: 'msg-copy',
        timestamp: new Date(),
        body: {
          object: { key: 'panos/u1/copy/original', size: 10 },
          action: 'CopyObject',
        },
        attempts: 1,
      },
    ]);
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'msg-copy' }]);
  });

  it('acks (not retries) an original larger than MAX_ORIGINAL_BYTES, and writes a tile-failed marker', async () => {
    const ctx = createExecutionContext();
    // env.MAX_ORIGINAL_BYTES is "157286400" (150 MiB) under wrangler.jsonc's
    // dev env - see wrangler.jsonc.
    const maxBytes = Number(env.MAX_ORIGINAL_BYTES);
    const key = 'panos/u1/oversized/original';
    // The marker write's resurrection guard (review fix) requires the
    // original to actually exist, with a matching eTag on the notification.
    await env.BUCKET.put(key, 'original bytes');
    const head = await env.BUCKET.head(key);
    const batch = createMessageBatch('pano-uploads-dev', [
      {
        id: 'msg-oversized',
        timestamp: new Date(),
        body: {
          object: { key, size: maxBytes + 1, eTag: head!.etag },
          action: 'PutObject',
        },
        attempts: 1,
      },
    ]);
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['msg-oversized']);
    expect(result.retryMessages).toEqual([]);
    const marker = await env.BUCKET.get(tileFailedKeyFromOriginalKey(key));
    expect((await marker!.json()) as { reason: string }).toMatchObject({ reason: 'oversize' });
  });

  it('does not oversize-skip a size exactly at MAX_ORIGINAL_BYTES', async () => {
    const ctx = createExecutionContext();
    const maxBytes = Number(env.MAX_ORIGINAL_BYTES);
    const batch = createMessageBatch('pano-uploads-dev', [
      {
        id: 'msg-at-limit',
        timestamp: new Date(),
        body: {
          object: { key: 'panos/u1/at-limit/original', size: maxBytes },
          action: 'PutObject',
        },
        attempts: 1,
      },
    ]);
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    // Not oversize-acked - it proceeds to the container call, which fails in
    // this Docker-less environment and is retried (see file header comment).
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'msg-at-limit' }]);
  });

  it('retries when the container call fails (the stub cannot start without a container runtime)', async () => {
    const ctx = createExecutionContext();
    const batch = createMessageBatch('pano-uploads-dev', [
      {
        id: 'msg-container-fails',
        timestamp: new Date(),
        body: {
          object: { key: 'panos/u1/container-fails/original', size: 10 },
          action: 'PutObject',
        },
        attempts: 1,
      },
    ]);
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'msg-container-fails' }]);
  });

  it('logs the failing key and error on the catch path, and still retries the message', async () => {
    // Also covers a DO constructor throw (missing R2 secrets): it reaches
    // this same catch block via stub.fetch() rejecting.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const key = 'panos/u1/logged-failure/original';
    const batch = createMessageBatch('pano-uploads-dev', [
      {
        id: 'msg-logged-failure',
        timestamp: new Date(),
        body: { object: { key, size: 10 }, action: 'PutObject' },
        attempts: 1,
      },
    ]);
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    // Still retries - the logging must not change ack/retry semantics.
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'msg-logged-failure' }]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0] as [string];
    expect(message).toContain(key);
  });

  it('acks and logs a key deriveUploadTarget rejects, without calling the container or writing a marker (invalid charset)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getSpy = vi.spyOn(env.TILER, 'get');
    try {
      const ctx = createExecutionContext();
      // Passes the action/suffix filters, but the panoId segment has a
      // space, which deriveUploadTarget rejects (upload-prefix.ts) - and,
      // since the review fix, tileFailedKeyFromOriginalKey rejects it too.
      const key = 'panos/u1/bad panoid/original';
      const batch = createMessageBatch('pano-uploads-dev', [
        {
          id: 'msg-unprocessable-key',
          timestamp: new Date(),
          body: { object: { key, size: 10 }, action: 'PutObject' },
          attempts: 1,
        },
      ]);
      await worker.queue(batch, env, ctx);
      const result = await getQueueResult(batch, ctx);

      expect(result.explicitAcks).toEqual(['msg-unprocessable-key']);
      expect(result.retryMessages).toEqual([]);
      expect(getSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message] = errorSpy.mock.calls[0] as [string];
      expect(message).toContain(key);
      // No junk marker for a key whose charset a stricter parse rejects.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot derive'));
      expect(await env.BUCKET.get('panos/u1/bad panoid/tile-failed')).toBeNull();
    } finally {
      getSpy.mockRestore();
    }
  });

  it('processes each message in a batch independently (partial ack/retry)', async () => {
    const ctx = createExecutionContext();
    const batch = createMessageBatch('pano-uploads-dev', [
      {
        id: 'msg-batch-filtered',
        timestamp: new Date(),
        body: {
          object: { key: 'panos/u1/batch/config.json', size: 10 },
          action: 'PutObject',
        },
        attempts: 1,
      },
      {
        id: 'msg-batch-container',
        timestamp: new Date(),
        body: {
          object: { key: 'panos/u1/batch/original', size: 10 },
          action: 'PutObject',
        },
        attempts: 1,
      },
    ]);
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['msg-batch-filtered']);
    expect(result.retryMessages).toEqual([{ msgId: 'msg-batch-container' }]);
  });
});

/**
 * Exercises the ack/retry decision directly by swapping `env.TILER.get` for
 * a fake stub whose `fetch` resolves with a response this suite controls.
 */
describe('res.ok handling', () => {
  it('acks a 2xx container response without logging anything', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fakeFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const getSpy = vi
      .spyOn(env.TILER, 'get')
      .mockReturnValue({ fetch: fakeFetch } as unknown as ReturnType<typeof env.TILER.get>);
    try {
      const ctx = createExecutionContext();
      const key = 'panos/u1/ok-response/original';
      const batch = createMessageBatch('pano-uploads-dev', [
        {
          id: 'msg-ok-response',
          timestamp: new Date(),
          body: { object: { key, size: 10 }, action: 'PutObject' },
          attempts: 1,
        },
      ]);
      await worker.queue(batch, env, ctx);
      const result = await getQueueResult(batch, ctx);
      expect(result.explicitAcks).toEqual(['msg-ok-response']);
      expect(result.retryMessages).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
    }
  });

  it('logs the key, status, and (truncated) body, and still retries, on a non-ok container response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const longBody = 'x'.repeat(600);
    const fakeFetch = vi.fn(async () => new Response(longBody, { status: 500 }));
    const getSpy = vi
      .spyOn(env.TILER, 'get')
      .mockReturnValue({ fetch: fakeFetch } as unknown as ReturnType<typeof env.TILER.get>);
    try {
      const ctx = createExecutionContext();
      const key = 'panos/u1/bad-response/original';
      const batch = createMessageBatch('pano-uploads-dev', [
        {
          id: 'msg-bad-response',
          timestamp: new Date(),
          body: { object: { key, size: 10 }, action: 'PutObject' },
          attempts: 1,
        },
      ]);
      await worker.queue(batch, env, ctx);
      const result = await getQueueResult(batch, ctx);
      // Not treated as a permanent failure, so it retries.
      expect(result.explicitAcks).toEqual([]);
      expect(result.retryMessages).toEqual([{ msgId: 'msg-bad-response' }]);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message] = errorSpy.mock.calls[0] as [string];
      expect(message).toContain(key);
      expect(message).toContain('500');
      // Truncated to ~500 chars - the full 600-char body must not appear.
      expect(message).not.toContain(longBody);
      expect(message).toContain('x'.repeat(500));
    } finally {
      getSpy.mockRestore();
    }
  });
});

// Unit B4: the same Worker also consumes its own DLQ (wrangler.jsonc), and
// `queue()` branches on `batch.queue` - always acking, never retrying further.
describe('DLQ handling', () => {
  it('writes a tile-failed marker and acks for a dead-lettered message with a valid key', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const key = 'panos/u1/dlq-valid/original';
    await env.BUCKET.put(key, 'original bytes');
    const head = await env.BUCKET.head(key);
    const batch = createMessageBatch('pano-uploads-dlq-dev', [
      {
        id: 'msg-dlq-valid',
        timestamp: new Date(),
        body: { object: { key, size: 10, eTag: head!.etag }, action: 'PutObject' },
        attempts: 4,
      },
    ]);

    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(['msg-dlq-valid']);
    expect(result.retryMessages).toEqual([]);
    const marker = await env.BUCKET.get(tileFailedKeyFromOriginalKey(key));
    const body = (await marker!.json()) as { reason: string; at: string; originalEtag: string };
    expect(body.reason).toBe('dlq');
    expect(typeof body.at).toBe('string');
    expect(body.originalEtag).toBe(head!.etag);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(key));
  });

  it('does not write a marker when the panoId charset is invalid (review fix), but still acks and logs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const key = 'panos/u1/bad panoid/original';
    const batch = createMessageBatch('pano-uploads-dlq-dev', [
      {
        id: 'msg-dlq-bad-panoid',
        timestamp: new Date(),
        body: { object: { key, size: 10 }, action: 'PutObject' },
        attempts: 4,
      },
    ]);

    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(['msg-dlq-bad-panoid']);
    expect(await env.BUCKET.get('panos/u1/bad panoid/tile-failed')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot derive'));
  });

  it('does not resurrect a deleted pano: no marker when the original no longer exists (review blocker)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    // Never put() this key - simulates deletePano having already swept
    // this prefix before this slow, retried DLQ delivery lands.
    const key = 'panos/u1/dlq-already-deleted/original';
    const batch = createMessageBatch('pano-uploads-dlq-dev', [
      {
        id: 'msg-dlq-already-deleted',
        timestamp: new Date(),
        body: { object: { key, size: 10 }, action: 'PutObject' },
        attempts: 4,
      },
    ]);

    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(['msg-dlq-already-deleted']);
    expect(await env.BUCKET.get(tileFailedKeyFromOriginalKey(key))).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no longer exists'));
  });

  it('acks and logs console.error when the marker write itself rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const key = 'panos/u1/dlq-put-rejects/original';
    await env.BUCKET.put(key, 'original bytes');
    const head = await env.BUCKET.head(key);
    const putSpy = vi.spyOn(env.BUCKET, 'put').mockRejectedValue(new Error('put boom'));
    try {
      const batch = createMessageBatch('pano-uploads-dlq-dev', [
        {
          id: 'msg-dlq-put-rejects',
          timestamp: new Date(),
          body: { object: { key, size: 10, eTag: head!.etag }, action: 'PutObject' },
          attempts: 4,
        },
      ]);

      await worker.queue(batch, env, ctx);
      const result = await getQueueResult(batch, ctx);

      expect(result.explicitAcks).toEqual(['msg-dlq-put-rejects']);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed to write'));
    } finally {
      putSpy.mockRestore();
    }
  });

  it('acks and logs, without writing a marker, for a key with no owner/panoId to hang one on', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const key = 'panos/only-one-segment/original';
    const batch = createMessageBatch('pano-uploads-dlq-dev', [
      {
        id: 'msg-dlq-unparseable',
        timestamp: new Date(),
        body: { object: { key, size: 10 }, action: 'PutObject' },
        attempts: 4,
      },
    ]);

    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(['msg-dlq-unparseable']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(key));
  });

  it('acks and logs, without throwing, a malformed message body (no object.key)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const batch = createMessageBatch('pano-uploads-dlq-dev', [
      {
        id: 'msg-dlq-malformed',
        timestamp: new Date(),
        // No `object` at all - a defensively-typed body, not the real
        // R2Event shape.
        body: {} as { object: { key: string } },
        attempts: 4,
      },
    ]);

    await expect(worker.queue(batch, env, ctx)).resolves.toBeUndefined();
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(['msg-dlq-malformed']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('msg-dlq-malformed'));
  });

  it('processes each dead-lettered message independently, acking all of them', async () => {
    const ctx = createExecutionContext();
    const keyA = 'panos/u1/dlq-batch-a/original';
    const keyB = 'panos/u1/dlq-batch-b/original';
    await env.BUCKET.put(keyA, 'a bytes');
    await env.BUCKET.put(keyB, 'b bytes');
    const etagA = (await env.BUCKET.head(keyA))!.etag;
    const etagB = (await env.BUCKET.head(keyB))!.etag;
    const batch = createMessageBatch('pano-uploads-dlq-dev', [
      {
        id: 'msg-dlq-batch-a',
        timestamp: new Date(),
        body: { object: { key: keyA, size: 10, eTag: etagA }, action: 'PutObject' },
        attempts: 4,
      },
      {
        id: 'msg-dlq-batch-b',
        timestamp: new Date(),
        body: { object: { key: keyB, size: 10, eTag: etagB }, action: 'PutObject' },
        attempts: 4,
      },
    ]);

    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks.slice().sort()).toEqual(['msg-dlq-batch-a', 'msg-dlq-batch-b']);
    expect(await env.BUCKET.get(tileFailedKeyFromOriginalKey(keyA))).not.toBeNull();
    expect(await env.BUCKET.get(tileFailedKeyFromOriginalKey(keyB))).not.toBeNull();
  });

  it('redelivery of the same dead-lettered key advances `at` rather than duplicating the marker', async () => {
    const key = 'panos/u1/dlq-redelivered/original';
    await env.BUCKET.put(key, 'original bytes');
    const etag = (await env.BUCKET.head(key))!.etag;
    const makeBatch = () =>
      createMessageBatch('pano-uploads-dlq-dev', [
        {
          id: 'msg-dlq-redelivered',
          timestamp: new Date(),
          body: { object: { key, size: 10, eTag: etag }, action: 'PutObject' },
          attempts: 4,
        },
      ]);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await worker.queue(makeBatch(), env, createExecutionContext());
      vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'));
      await worker.queue(makeBatch(), env, createExecutionContext());
    } finally {
      vi.useRealTimers();
    }

    const markerKey = tileFailedKeyFromOriginalKey(key);
    const list = await env.BUCKET.list({ prefix: markerKey });
    expect(list.objects).toHaveLength(1);
    const marker = await env.BUCKET.get(markerKey);
    const body = (await marker!.json()) as { at: string };
    expect(body.at).toBe('2026-01-01T00:00:10.000Z');
  });

  it('still acks when the marker write HEAD rejects (an R2 error must not change the ack decision)', async () => {
    const ctx = createExecutionContext();
    const key = 'panos/u1/dlq-head-rejects/original';
    await env.BUCKET.put(key, 'original bytes');
    const headSpy = vi.spyOn(env.BUCKET, 'head').mockRejectedValue(new Error('head boom'));
    try {
      const batch = createMessageBatch('pano-uploads-dlq-dev', [
        {
          id: 'msg-dlq-head-rejects',
          timestamp: new Date(),
          body: { object: { key, size: 10, eTag: 'whatever' }, action: 'PutObject' },
          attempts: 4,
        },
      ]);

      await worker.queue(batch, env, ctx);
      const result = await getQueueResult(batch, ctx);

      expect(result.explicitAcks).toEqual(['msg-dlq-head-rejects']);
      expect(result.retryMessages).toEqual([]);
    } finally {
      headSpy.mockRestore();
    }
  });
});

describe('queue routing: exact match, not a substring test (review fix)', () => {
  it('a queue name containing "-dlq" as a substring, but not an exact DLQ name, is routed as a main queue', async () => {
    const ctx = createExecutionContext();
    const key = 'panos/u1/not-really-dlq/original';
    const batch = createMessageBatch('pano-uploads-dlq-staging', [
      {
        id: 'msg-not-dlq-queue',
        timestamp: new Date(),
        body: { object: { key, size: 10 }, action: 'PutObject' },
        attempts: 1,
      },
    ]);

    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);

    // Main-queue semantics (retried on a failed container call), not the
    // DLQ handler's always-ack - proves exact-set matching, not `.includes`.
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'msg-not-dlq-queue' }]);
  });

  it('the production DLQ name (no "-dev" suffix) is also routed to the DLQ handler', async () => {
    const ctx = createExecutionContext();
    const key = 'panos/u1/dlq-prod-name/original';
    await env.BUCKET.put(key, 'original bytes');
    const head = await env.BUCKET.head(key);
    const batch = createMessageBatch('pano-uploads-dlq', [
      {
        id: 'msg-dlq-prod-name',
        timestamp: new Date(),
        body: { object: { key, size: 10, eTag: head!.etag }, action: 'PutObject' },
        attempts: 4,
      },
    ]);

    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(['msg-dlq-prod-name']);
    expect(await env.BUCKET.get(tileFailedKeyFromOriginalKey(key))).not.toBeNull();
  });
});
