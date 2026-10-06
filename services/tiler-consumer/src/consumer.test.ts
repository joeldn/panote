import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { tileFailedKeyFromOriginalKey } from '@internal/contracts';
import worker from './consumer.js';

// Owner segment for the log-hygiene tests. Distinctive, so a substring
// match can't come from anything but a leaked key or owner.
const OWNER = 'ownerSECRETx';

// Spies on every console method a log line could go through. Call it first
// in a test: a later vi.spyOn on the same method returns this same spy.
const spyOnAllConsole = () =>
  (['log', 'info', 'warn', 'error'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );

const expectOwnerNeverLogged = (spies: ReturnType<typeof spyOnAllConsole>): void => {
  for (const spy of spies)
    for (const call of spy.mock.calls) expect(call.map(String).join(' ')).not.toContain(OWNER);
};

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
    const consoleSpies = spyOnAllConsole();
    const ctx = createExecutionContext();
    // env.MAX_ORIGINAL_BYTES is "157286400" (150 MiB) under wrangler.jsonc's
    // dev env - see wrangler.jsonc.
    const maxBytes = Number(env.MAX_ORIGINAL_BYTES);
    const key = `panos/${OWNER}/oversized/original`;
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
    expectOwnerNeverLogged(consoleSpies);
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

  it('logs the failing panoId (not the owner-bearing key) on the catch path, and still retries the message', async () => {
    const consoleSpies = spyOnAllConsole();
    // Also covers a DO constructor throw (missing R2 secrets): it reaches
    // this same catch block via stub.fetch() rejecting.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const key = `panos/${OWNER}/logged-failure/original`;
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
    expect(message).toContain('pano=logged-failure');
    expect(message).not.toContain(OWNER);
    expectOwnerNeverLogged(consoleSpies);
  });

  it('acks and logs a key deriveUploadTarget rejects, without calling the container or writing a marker (invalid charset)', async () => {
    const consoleSpies = spyOnAllConsole();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getSpy = vi.spyOn(env.TILER, 'get');
    try {
      const ctx = createExecutionContext();
      // Passes the action/suffix filters, but the panoId segment has a
      // space, which deriveUploadTarget rejects (upload-prefix.ts) - and,
      // since the review fix, tileFailedKeyFromOriginalKey rejects it too.
      const key = `panos/${OWNER}/bad panoid/original`;
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
      expect(message).toContain('pano=bad panoid');
      expect(message).not.toContain(OWNER);
      // No junk marker for a key whose charset a stricter parse rejects.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot derive'));
      expect(await env.BUCKET.get(`panos/${OWNER}/bad panoid/tile-failed`)).toBeNull();
    } finally {
      getSpy.mockRestore();
    }
    expectOwnerNeverLogged(consoleSpies);
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
// Owners that fail the charset check, through both the main queue (the
// unprocessable-key path) and the DLQ: no console method may see them.
describe('malformed owner segments never reach the logs', () => {
  it.each([
    ['pano-uploads-dev', 'an @', 'secret@example.com'],
    ['pano-uploads-dev', 'a %', 'secret%owner'],
    ['pano-uploads-dev', 'a space', 'secret owner'],
    ['pano-uploads-dlq-dev', 'an @', 'secret@example.com'],
    ['pano-uploads-dlq-dev', 'a %', 'secret%owner'],
    ['pano-uploads-dlq-dev', 'a space', 'secret owner'],
  ])('%s, owner with %s', async (queue, _label, owner) => {
    const consoleSpies = spyOnAllConsole();
    const ctx = createExecutionContext();
    const key = `panos/${owner}/p1/original`;
    const batch = createMessageBatch(queue, [
      {
        id: 'msg-bad-owner',
        timestamp: new Date(),
        body: { object: { key, size: 10, eTag: 'etag' }, action: 'PutObject' },
        attempts: 1,
      },
    ]);

    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(['msg-bad-owner']);
    for (const spy of consoleSpies)
      for (const call of spy.mock.calls) expect(call.map(String).join(' ')).not.toContain('secret');
    // Something was logged, naming the pano.
    expect(
      consoleSpies.some((spy) => spy.mock.calls.some((c) => String(c[0]).includes('pano=p1'))),
    ).toBe(true);
  });
});

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

  it('logs the panoId, status, and (truncated) body, and still retries, on a non-ok container response', async () => {
    const consoleSpies = spyOnAllConsole();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const longBody = 'x'.repeat(600);
    const fakeFetch = vi.fn(async () => new Response(longBody, { status: 500 }));
    const getSpy = vi
      .spyOn(env.TILER, 'get')
      .mockReturnValue({ fetch: fakeFetch } as unknown as ReturnType<typeof env.TILER.get>);
    try {
      const ctx = createExecutionContext();
      const key = `panos/${OWNER}/bad-response/original`;
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
      expect(message).toContain('pano=bad-response');
      expect(message).not.toContain(OWNER);
      expect(message).toContain('500');
      // Truncated to ~500 chars - the full 600-char body must not appear.
      expect(message).not.toContain(longBody);
      expect(message).toContain('x'.repeat(500));
    } finally {
      getSpy.mockRestore();
    }
    expectOwnerNeverLogged(consoleSpies);
  });
});

// Unit B4: the same Worker also consumes its own DLQ (wrangler.jsonc), and
// `queue()` branches on `batch.queue` - always acking, never retrying further.
describe('DLQ handling', () => {
  it('writes a tile-failed marker and acks for a dead-lettered message with a valid key', async () => {
    const consoleSpies = spyOnAllConsole();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const key = `panos/${OWNER}/dlq-valid/original`;
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
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('pano=dlq-valid'));
    for (const call of errorSpy.mock.calls) expect(call.join(' ')).not.toContain(OWNER);
    expectOwnerNeverLogged(consoleSpies);
  });

  it('does not write a marker when the panoId charset is invalid (review fix), but still acks and logs', async () => {
    const consoleSpies = spyOnAllConsole();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const key = `panos/${OWNER}/bad panoid/original`;
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
    expect(await env.BUCKET.get(`panos/${OWNER}/bad panoid/tile-failed`)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot derive'));
    expectOwnerNeverLogged(consoleSpies);
  });

  it('does not resurrect a deleted pano: no marker when the original no longer exists (review blocker)', async () => {
    const consoleSpies = spyOnAllConsole();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    // Never put() this key - simulates deletePano having already swept
    // this prefix before this slow, retried DLQ delivery lands.
    const key = `panos/${OWNER}/dlq-already-deleted/original`;
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
    expectOwnerNeverLogged(consoleSpies);
  });

  it('acks and logs console.error when the marker write itself rejects', async () => {
    const consoleSpies = spyOnAllConsole();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const key = `panos/${OWNER}/dlq-put-rejects/original`;
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
    expectOwnerNeverLogged(consoleSpies);
  });

  it('acks and logs, without writing a marker, for a key with no owner/panoId to hang one on', async () => {
    const consoleSpies = spyOnAllConsole();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const key = `panos/${OWNER}/original`;
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
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('cannot derive tile-failed marker pano=<unparsed-key>'),
    );
    expectOwnerNeverLogged(consoleSpies);
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
    const consoleSpies = spyOnAllConsole();
    const ctx = createExecutionContext();
    const key = `panos/${OWNER}/dlq-head-rejects/original`;
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
    expectOwnerNeverLogged(consoleSpies);
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

// DLQ alert email (src/alert.ts): the binding is mocked; miniflare never sends.
describe('DLQ alert email', () => {
  const RECIPIENT = 'owner@example.com';
  const withAlert = (
    send: (...args: unknown[]) => Promise<unknown>,
    to: string | null = RECIPIENT,
    overrides: Record<string, unknown> = {},
  ) =>
    ({
      ...env,
      ALERT_EMAIL_TO: to ?? undefined,
      ALERT_EMAIL: { send },
      ...overrides,
    }) as unknown as typeof env;
  const oneDlqMessage = (id: string) =>
    createMessageBatch('pano-uploads-dlq-dev', [
      {
        id,
        timestamp: new Date(),
        body: { object: { key: `panos/u1/${id}/original`, size: 10 }, action: 'PutObject' },
        attempts: 4,
      },
    ]);

  it('sends one email per batch listing every key, including a message with no object.key', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Filled in by the send mock: how many acks had landed by the time send ran.
    let ackedAtSend = -1;
    const send = vi.fn(async () => {
      ackedAtSend = ackSpies.filter((s) => s.mock.calls.length === 1).length;
      return { messageId: 'm1' };
    });
    const keyA = 'panos/u1/alert-a/original';
    const keyB = 'panos/u1/alert-b/original';
    await env.BUCKET.put(keyA, 'a bytes');
    const etagA = (await env.BUCKET.head(keyA))!.etag;
    const ctx = createExecutionContext();
    const batch = createMessageBatch('pano-uploads-dlq-dev', [
      {
        id: 'msg-alert-a',
        timestamp: new Date(),
        body: { object: { key: keyA, size: 10, eTag: etagA }, action: 'PutObject' },
        attempts: 4,
      },
      {
        id: 'msg-alert-b',
        timestamp: new Date(),
        body: { object: { key: keyB, size: 10 }, action: 'PutObject' },
        attempts: 4,
      },
      {
        id: 'msg-alert-nokey',
        timestamp: new Date(),
        body: {} as { object: { key: string } },
        attempts: 4,
      },
    ]);
    const ackSpies = batch.messages.map((m) => vi.spyOn(m, 'ack'));

    await worker.queue(batch, withAlert(send), ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks.slice().sort()).toEqual([
      'msg-alert-a',
      'msg-alert-b',
      'msg-alert-nokey',
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ackedAtSend).toBe(3);
    const [msg] = send.mock.calls[0] as unknown as [
      { to: string; from: string; subject: string; text: string },
    ];
    expect(msg.to).toBe(RECIPIENT);
    expect(msg.from).toBe('tiler-alerts@panote.io');
    expect(msg.subject).toBe('[panote] tiling failed permanently (3) - pano-uploads-dlq-dev');
    expect(msg.text).toContain(`${keyA} (marker: written)`);
    expect(msg.text).toContain(`${keyB} (marker: skipped)`);
    expect(msg.text).toContain('msg-alert-nokey');
    expect(msg.text).toContain('Queue: pano-uploads-dlq-dev');
    expect(msg.text).toMatch(/Time \(UTC\): \d{4}-\d\d-\d\dT[\d:.]+Z/);
    expect(warnSpy).toHaveBeenCalledWith('DLQ alert sent for pano-uploads-dlq-dev messageId=m1');
    for (const call of warnSpy.mock.calls) expect(call.join(' ')).not.toContain(RECIPIENT);
  });

  it('logs the send as sent with messageId=unknown when send resolves without one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = vi.fn(async () => ({}) as { messageId?: string });
    const ctx = createExecutionContext();
    const batch = oneDlqMessage('msg-alert-no-messageid');

    await worker.queue(batch, withAlert(send), ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(['msg-alert-no-messageid']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'DLQ alert sent for pano-uploads-dlq-dev messageId=unknown',
    );
  });

  it('still acks every message when send throws, and logs the error without the recipient', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = vi.fn(async () => {
      // The message echoes the address, so it must never reach the log.
      throw Object.assign(new Error(`Recipient ${RECIPIENT} not in allowed list`), {
        code: 'E_RECIPIENT_NOT_ALLOWED',
      });
    });
    const ctx = createExecutionContext();
    const batch = createMessageBatch('pano-uploads-dlq-dev', [
      {
        id: 'msg-alert-throw-1',
        timestamp: new Date(),
        body: { object: { key: 'panos/u1/alert-throw-1/original', size: 10 }, action: 'PutObject' },
        attempts: 4,
      },
      {
        id: 'msg-alert-throw-2',
        timestamp: new Date(),
        body: { object: { key: 'panos/u1/alert-throw-2/original', size: 10 }, action: 'PutObject' },
        attempts: 4,
      },
    ]);

    await expect(worker.queue(batch, withAlert(send), ctx)).resolves.toBeUndefined();
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks.slice().sort()).toEqual(['msg-alert-throw-1', 'msg-alert-throw-2']);
    expect(result.retryMessages).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.map((c) => c.map(String).join(' '));
    const sendError = logged.find((l) => l.includes('failed to send DLQ alert'));
    expect(sendError).toContain('code=E_RECIPIENT_NOT_ALLOWED');
    expect(sendError).toContain('name=Error');
    expect(sendError).not.toContain('not in allowed list');
    for (const line of logged) expect(line).not.toContain(RECIPIENT);
  });

  it('does not send, and warns, when ALERT_EMAIL_TO is unset', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn(async () => ({ messageId: 'm1' }));
    const ctx = createExecutionContext();
    const batch = createMessageBatch('pano-uploads-dlq-dev', [
      {
        id: 'msg-alert-no-to',
        timestamp: new Date(),
        body: { object: { key: 'panos/u1/alert-no-to/original', size: 10 }, action: 'PutObject' },
        attempts: 4,
      },
    ]);

    await worker.queue(batch, withAlert(send, null), ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(['msg-alert-no-to']);
    expect(send).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skip DLQ alert'));
  });

  it.each([
    ['the ALERT_EMAIL binding is missing', { ALERT_EMAIL: undefined }],
    ['ALERT_EMAIL_FROM is unset', { ALERT_EMAIL_FROM: undefined }],
  ])('does not send, and warns, when %s', async (_label, overrides) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.fn(async () => ({ messageId: 'm1' }));
    const ctx = createExecutionContext();
    const batch = oneDlqMessage('msg-alert-skip');

    await expect(
      worker.queue(batch, withAlert(send, RECIPIENT, overrides), ctx),
    ).resolves.toBeUndefined();
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(['msg-alert-skip']);
    expect(send).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ALERT_EMAIL_FROM'));
  });

  it('never sends from the main (non-DLQ) queue, even on a permanent failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = vi.fn(async () => ({ messageId: 'm1' }));
    const ctx = createExecutionContext();
    const batch = createMessageBatch('pano-uploads-dev', [
      {
        id: 'msg-main-unprocessable',
        timestamp: new Date(),
        body: { object: { key: 'panos/u1/bad panoid/original', size: 10 }, action: 'PutObject' },
        attempts: 1,
      },
      {
        id: 'msg-main-retry',
        timestamp: new Date(),
        body: { object: { key: 'panos/u1/main-retry/original', size: 10 }, action: 'PutObject' },
        attempts: 1,
      },
    ]);

    await worker.queue(batch, withAlert(send), ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(['msg-main-unprocessable']);
    expect(result.retryMessages).toEqual([{ msgId: 'msg-main-retry' }]);
    expect(send).not.toHaveBeenCalled();
  });
});
