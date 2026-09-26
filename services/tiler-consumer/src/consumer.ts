import { Container } from '@cloudflare/containers';
import { containerEnvVars } from './container-env.js';
import { deriveUploadTarget } from './upload-prefix.js';
import { writeFailureMarker } from './failure-marker.js';

export class Tiler extends Container<Env> {
  override defaultPort = 8080;
  // Each pano keys its own container (idFromName(key)), so a warm instance is
  // never reused - keep the post-job idle window short to avoid billing 4 GiB
  // for nothing. Tiling itself (~2-4 min) is billed regardless; this only
  // trims the idle tail after the tile response returns.
  override sleepAfter = '1m';

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    // wrangler's `[[containers]]` block only carries build-time `image_vars`,
    // never a runtime env - so the R2 credentials the container process reads
    // from process.env (src/container.ts) have to be forwarded explicitly
    // here, or the container's S3 client resolves to
    // https://undefined.r2.cloudflarestorage.com/undefined and every tile job
    // 500s into the DLQ, silently. See src/container-env.ts.
    this.envVars = containerEnvVars(env);
  }
}

interface R2Event {
  object: { key: string; size?: number; eTag?: string };
  action: string;
}

// R2 object-create actions that can produce a new `original`. A single PUT is
// `PutObject`, but a large multipart upload finishes as
// `CompleteMultipartUpload` and a server-side copy as `CopyObject` -
// matching only `PutObject` would silently drop those (the pano would never
// tile).
const CREATE_ACTIONS = ['PutObject', 'CompleteMultipartUpload', 'CopyObject'];
// Coarse DoS guard: originals larger than this are never tiled (the
// container is sized for the ~150 MP v1 cap). Overridable via the
// MAX_ORIGINAL_BYTES var.
const DEFAULT_MAX_ORIGINAL_BYTES = 150 * 1024 * 1024;

// Exact match, not a substring test (wrangler.jsonc): a hypothetical main
// queue whose name happens to contain "-dlq" must not route here.
const DLQ_QUEUE_NAMES = new Set(['pano-uploads-dlq-dev', 'pano-uploads-dlq']);

// A dead-lettered message has already exhausted max_retries on the main
// queue - nothing here is retried, only marked and acked.
const handleDlqBatch = async (batch: MessageBatch<R2Event>, env: Env): Promise<void> => {
  for (const msg of batch.messages) {
    // Defensive: the body should mirror the R2 event that fed the main
    // queue, but a malformed one must not throw.
    const key = msg.body?.object?.key;
    if (typeof key !== 'string') {
      console.error(`dead-lettered message ${msg.id} has no object.key`);
      msg.ack();
      continue;
    }
    console.error(`tile job dead-lettered for ${key} after exhausting retries`);
    await writeFailureMarker(env.BUCKET, key, 'dlq', msg.body.object.eTag);
    msg.ack();
  }
};

const handleUploadsBatch = async (batch: MessageBatch<R2Event>, env: Env): Promise<void> => {
  const maxBytes = Number(env.MAX_ORIGINAL_BYTES) || DEFAULT_MAX_ORIGINAL_BYTES;
  for (const msg of batch.messages) {
    const { key, size } = msg.body.object;
    const { action } = msg.body;
    if (!CREATE_ACTIONS.some((a) => action.startsWith(a)) || !key.endsWith('/original')) {
      msg.ack();
      continue;
    }
    if (typeof size === 'number' && size > maxBytes) {
      // ack (not retry): an oversized original will never fit, so
      // retrying only burns the container until it dead-letters.
      console.warn(`skip oversized original ${key}: ${size} > ${maxBytes}`);
      await writeFailureMarker(env.BUCKET, key, 'oversize', msg.body.object.eTag);
      msg.ack();
      continue;
    }
    try {
      // Acks keys that can never succeed rather than retrying (each retry
      // starts a 4 GiB container just to 500 on the same rejected key).
      deriveUploadTarget(key);
    } catch (e) {
      console.error(`skip unprocessable key ${key}: ${e instanceof Error ? e.message : String(e)}`);
      await writeFailureMarker(env.BUCKET, key, 'unprocessable-key', msg.body.object.eTag);
      msg.ack();
      continue;
    }
    try {
      const stub = env.TILER.get(env.TILER.idFromName(key));
      const res = await stub.fetch('https://container/tile', {
        method: 'POST',
        body: JSON.stringify({ key }),
      });
      if (res.ok) {
        msg.ack();
      } else {
        // container.ts puts its error text in the body; log it or a
        // tiling failure dead-letters with no trace of the cause.
        let bodyText = '<failed to read response body>';
        try {
          bodyText = (await res.text()).slice(0, 500);
        } catch {
          // A failed body read must not block the retry below.
        }
        console.error(`tile job for ${key} failed: ${res.status} ${bodyText}`);
        msg.retry();
      }
    } catch (e) {
      // Covers a failed fetch and a DO constructor throw (missing R2
      // secrets, container-env.ts); e's message never contains a secret.
      console.error(`tile job failed for ${key}: ${e instanceof Error ? e.message : String(e)}`);
      msg.retry();
    }
  }
};

export default {
  async queue(batch: MessageBatch<R2Event>, env: Env): Promise<void> {
    if (DLQ_QUEUE_NAMES.has(batch.queue)) {
      await handleDlqBatch(batch, env);
      return;
    }
    await handleUploadsBatch(batch, env);
  },
};
