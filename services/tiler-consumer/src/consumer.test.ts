import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
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
 * What is consequently NOT covered: the `if (res.ok) msg.ack(); else
 * msg.retry();` decision is never evaluated at all - neither "container
 * returns 2xx -> ack" nor "container returns 500 -> retry" from §6.5's case
 * list. Mutation-tested: replacing that statement with a bare `msg.ack();`,
 * flipping it to `if (!res.ok)`, or changing its `else` to `msg.ack()` all
 * leave this suite fully green; only mutating the `catch` arm fails cases
 * here. So the cases below that assert a retry are proving the message got
 * past the action/suffix/size filters and reached the container call - not
 * that any particular container response is handled correctly. Closing this
 * gap needs a running container image, or a non-container Durable Object
 * stood up in a second wrangler env; neither is in scope for this port.
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

  it('acks (not retries) an original larger than MAX_ORIGINAL_BYTES', async () => {
    const ctx = createExecutionContext();
    // env.MAX_ORIGINAL_BYTES is "157286400" (150 MiB) under wrangler.jsonc's
    // dev env - see wrangler.jsonc.
    const maxBytes = Number(env.MAX_ORIGINAL_BYTES);
    const batch = createMessageBatch('pano-uploads-dev', [
      {
        id: 'msg-oversized',
        timestamp: new Date(),
        body: {
          object: { key: 'panos/u1/oversized/original', size: maxBytes + 1 },
          action: 'PutObject',
        },
        attempts: 1,
      },
    ]);
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['msg-oversized']);
    expect(result.retryMessages).toEqual([]);
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
