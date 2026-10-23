import { Container } from '@cloudflare/containers';
import { manifestKey, redactOwner } from '@internal/contracts';
import { TILER_OUTPUT_VERSION } from '@internal/tiler/version';
import { containerEnvVars } from './container-env.js';
import { deriveUploadTarget, errorText, panoIdForLog } from './upload-prefix.js';
import { deleteOversizedOriginal, writeFailureMarker } from './failure-marker.js';
import { sendDlqAlert, type DeadLetteredItem } from './alert.js';
import { runHealthCheck } from './health.js';

export class Tiler extends Container<Env> {
  override defaultPort = 8080;
  // Each pano keys its own container (idFromName(key)), so a warm instance is
  // never reused - keep the post-job idle window short to avoid billing 12 GiB
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
  /**
   * Set only by services/admin-api/scripts/retile.ts, never by R2: tile even
   * when the manifest already names this original's version (alreadyTiled).
   */
  force?: boolean;
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

// Back-off between attempts of a failed tile job: 1, 2, then 4 minutes before
// max_retries (3) sends it to the DLQ. A failure that isn't about the source is
// usually R2 or the container platform, which an immediate retry would just hit
// again; spacing them out also stops a burst of failing jobs from holding all
// max_concurrency slots back to back. Matches retry_delay in wrangler.jsonc, which
// covers a retry this code didn't ask for (an uncaught throw).
export const RETRY_BASE_SECONDS = 60;
export const retryDelaySeconds = (attempts: number): number =>
  RETRY_BASE_SECONDS * 2 ** Math.min(Math.max(attempts, 1) - 1, 4);

// R2 event etags may arrive quoted (S3-style) or bare.
const bareEtag = (raw: string): string => raw.replace(/^"|"$/g, '');

/**
 * True when the pano's manifest already names the version this original would
 * tile into (t<TILER_OUTPUT_VERSION>-<ETag>, as container.ts derives it): the
 * same bytes were already tiled by this tiler build, so the job would only
 * rewrite identical keys. R2 fires an event for every PUT, including one that
 * re-uploads the same bytes, and the queue can deliver twice. A failed or
 * unreadable manifest read answers false, so the job runs as before.
 */
export const alreadyTiled = async (
  bucket: R2Bucket,
  panoId: string,
  eTag: string | undefined,
): Promise<boolean> => {
  if (!eTag) return false;
  try {
    const obj = await bucket.get(manifestKey(panoId));
    if (!obj) return false;
    const { version } = (await obj.json()) as { version?: unknown };
    return version === `t${TILER_OUTPUT_VERSION}-${bareEtag(eTag)}`;
  } catch (e) {
    console.warn(`could not read the manifest pano=${panoId}, tiling anyway: ${errorText(e)}`);
    return false;
  }
};

// Exact match, not a substring test (wrangler.jsonc): a hypothetical main
// queue whose name happens to contain "-dlq" must not route here.
const DLQ_QUEUE_NAMES = new Set(['pano-uploads-dlq-dev', 'pano-uploads-dlq']);

// A dead-lettered message has already exhausted max_retries on the main
// queue - nothing here is retried, only marked and acked.
const handleDlqBatch = async (batch: MessageBatch<R2Event>, env: Env): Promise<void> => {
  const dead: DeadLetteredItem[] = [];
  for (const msg of batch.messages) {
    // Defensive: the body should mirror the R2 event that fed the main
    // queue, but a malformed one must not throw.
    const key = msg.body?.object?.key;
    if (typeof key !== 'string') {
      console.error(`dead-lettered message ${msg.id} has no object.key`);
      dead.push({ key: null, messageId: msg.id, marker: 'none' });
      msg.ack();
      continue;
    }
    console.error(`tile job dead-lettered pano=${panoIdForLog(key)} after exhausting retries`);
    const marker = await writeFailureMarker(env.BUCKET, key, 'dlq', msg.body.object.eTag);
    dead.push({ key, messageId: msg.id, marker });
    msg.ack();
  }
  // After the loop, so every message is already acked whatever happens here.
  await sendDlqAlert(env, batch.queue, dead);
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
      // retrying only burns the container until it dead-letters. The
      // original itself is deleted too, unless the pano has live tiles.
      console.warn(`skip oversized original pano=${panoIdForLog(key)}: ${size} > ${maxBytes}`);
      const marker = await writeFailureMarker(env.BUCKET, key, 'oversize', msg.body.object.eTag);
      // Only with the marker in place, or the owner would see the pano vanish
      // rather than fail.
      if (marker === 'written')
        await deleteOversizedOriginal(env.BUCKET, key, msg.body.object.eTag);
      msg.ack();
      continue;
    }
    let panoId: string;
    try {
      // Acks keys that can never succeed rather than retrying (each retry
      // starts a 12 GiB container just to 500 on the same rejected key).
      ({ panoId } = deriveUploadTarget(key));
    } catch (e) {
      console.error(`skip unprocessable key pano=${panoIdForLog(key)}: ${errorText(e)}`);
      await writeFailureMarker(env.BUCKET, key, 'unprocessable-key', msg.body.object.eTag);
      msg.ack();
      continue;
    }
    // panoId only in log lines from here on: the key carries the owner segment.
    if (msg.body.force !== true && (await alreadyTiled(env.BUCKET, panoId, msg.body.object.eTag))) {
      console.warn(
        `skip tile job pano=${panoId}: the manifest already has this original's version`,
      );
      msg.ack();
      continue;
    }
    const t0 = Date.now();
    const elapsed = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
    console.warn(`tile job start pano=${panoId}`);
    try {
      const stub = env.TILER.get(env.TILER.idFromName(key));
      const res = await stub.fetch('https://container/tile', {
        method: 'POST',
        body: JSON.stringify({ key }),
      });
      console.warn(`tile job end pano=${panoId} status=${res.status} after ${elapsed()}`);
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
        console.error(`tile job failed pano=${panoId}: ${res.status} ${redactOwner(bodyText)}`);
        if (res.status === 422) {
          // The tiler refused the source itself (format, pixel or aspect cap):
          // the same bytes fail the same way, so mark it failed now rather than
          // retrying into the DLQ. The original stays; a new upload replaces it.
          // Acked once the marker is written or not needed ('skipped': the original
          // changed or went); a failed write retries, and if the retries run out
          // the DLQ writes its own marker, so the owner always sees the failure.
          const marker = await writeFailureMarker(
            env.BUCKET,
            key,
            'unsupported',
            msg.body.object.eTag,
          );
          if (marker === 'failed') msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
          else msg.ack();
        } else {
          msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
        }
      }
    } catch (e) {
      // Covers a failed fetch and a DO constructor throw (missing R2
      // secrets, container-env.ts); e's message never contains a secret.
      console.warn(`tile job end pano=${panoId} threw after ${elapsed()}`);
      console.error(`tile job failed pano=${panoId}: ${errorText(e)}`);
      msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
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
  // Every 5 minutes: probes the site and APIs, checks admin-api's daily cron and CDN
  // purges, and emails when something goes down or comes back (src/health.ts).
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runHealthCheck(env, controller.scheduledTime));
  },
};
