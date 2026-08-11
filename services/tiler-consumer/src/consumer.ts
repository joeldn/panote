import { Container } from '@cloudflare/containers';

// TODO(commit 11): container.ts builds its AwsClient from process.env at
// module scope, but this class never sets `envVars`, and wrangler's
// `[[containers]]` block only carries build-time `image_vars` - so at
// runtime the container's S3 client points at
// https://undefined.r2.cloudflarestorage.com/undefined and every tile job
// 500s into the DLQ, silently (the upload itself succeeds; the pano just
// never becomes ready). This is a pre-existing bug carried over faithfully
// from the source (pano-viewer), not introduced by this port. The next
// commit fixes it by forwarding the R2 credentials through `envVars`
// (src/container-env.ts) and failing fast in the container if they are
// missing.
export class Tiler extends Container<Env> {
  override defaultPort = 8080;
  // Each pano keys its own container (idFromName(key)), so a warm instance is
  // never reused - keep the post-job idle window short to avoid billing 4 GiB
  // for nothing. Tiling itself (~2-4 min) is billed regardless; this only
  // trims the idle tail after the tile response returns.
  override sleepAfter = '1m';
}

interface R2Event {
  object: { key: string; size?: number };
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

export default {
  async queue(batch: MessageBatch<R2Event>, env: Env): Promise<void> {
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
        msg.ack();
        continue;
      }
      try {
        const stub = env.TILER.get(env.TILER.idFromName(key));
        const res = await stub.fetch('https://container/tile', {
          method: 'POST',
          body: JSON.stringify({ key }),
        });
        if (res.ok) msg.ack();
        else msg.retry();
      } catch {
        msg.retry();
      }
    }
  },
};
