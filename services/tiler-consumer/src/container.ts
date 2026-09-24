// The container entrypoint (runs on Node inside the image, CMD ["node", "dist/container.js"]).
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { build, TILER_OUTPUT_VERSION } from '@internal/tiler';
import { createR2S3Client } from '@internal/worker-kit/r2-s3';
import { manifestKey, PANO_PATTERN, tileVersionPrefix } from '@internal/contracts';
import { deriveUploadTarget } from './upload-prefix.js';
import { uploadDir, type PutFn } from './r2io.js';

// The Tiler DO (src/consumer.ts) forwards these through `Container.envVars`
// (src/container-env.ts) because wrangler's `[[containers]]` block only
// carries build-time `image_vars`, never a runtime env. Fail loudly here
// instead of silently building an `https://undefined...` URL and 500ing
// every tile job into the DLQ.
const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`tiler container: missing required env ${name}`);
  return value;
};

const r2 = createR2S3Client({
  accountId: requireEnv('R2_ACCOUNT_ID'),
  bucket: requireEnv('R2_BUCKET'),
  accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
});
// The /tile body is a tiny `{ key }` JSON; cap it so a malformed request
// can't buffer unbounded memory.
const MAX_TILE_REQUEST_BYTES = 64 * 1024;
// Defense-in-depth mirror of the consumer's size guard, in case an original
// slips through without a known size on the queue event.
const MAX_ORIGINAL_BYTES = Number(process.env.MAX_ORIGINAL_BYTES) || 150 * 1024 * 1024;

const put: PutFn = async (key, body, ct) => {
  // Tiles are immutable (long TTL); manifest.json is the readiness flag and
  // must re-fetch quickly (short TTL) - see the plan's caching contract.
  const cacheControl = key.endsWith('/manifest.json')
    ? 'public, max-age=30'
    : 'public, max-age=31536000, immutable';
  await r2.put(key, body, { contentType: ct, cacheControl });
};

const walk = async (dir: string, root = dir, acc: Record<string, Uint8Array> = {}) => {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, root, acc);
    else acc[relative(root, p)] = new Uint8Array(await readFile(p));
  }
  return acc;
};

// S3 ETags are double-quoted; the quotes are stripped once here so every
// comparison and the derived version string work on the bare value.
const stripEtagQuotes = (raw: string | null): string | null =>
  raw === null ? null : raw.replace(/^"|"$/g, '');

// Continues past a per-key failure so a partial cleanup still removes as
// much as it can; a failure here dead-letters the job, failed keys logged.
const deleteKeys = async (keys: string[]): Promise<void> => {
  const failed: string[] = [];
  for (const k of keys) {
    try {
      await r2.deleteObject(k);
    } catch (e) {
      failed.push(k);
      console.error(`failed to delete ${k}: ${String(e)}`);
    }
  }
  if (failed.length) throw new Error(`cleanup failed to delete: ${failed.join(', ')}`);
};

createServer((req, res) => {
  // SECURITY BOUNDARY: this port is reachable only through the Tiler
  // Durable Object stub - Cloudflare Containers are not publicly routable -
  // so requests are trusted to come from our own queue consumer. The guards
  // below are defense-in-depth, not the primary access control.
  if (req.method !== 'POST' || req.url !== '/tile') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  let tooLarge = false;
  req.on('data', (c) => {
    if (tooLarge) return;
    body += c;
    if (body.length > MAX_TILE_REQUEST_BYTES) {
      tooLarge = true;
      res.writeHead(413).end('request too large');
      req.destroy();
    }
  });
  req.on('end', async () => {
    if (tooLarge) return;
    try {
      const { key } = JSON.parse(body) as { key: string };
      // Validates the key and derives panoId; the owner plays no further
      // part, since tile/manifest output is owner-free.
      const { panoId } = deriveUploadTarget(key);
      const orig = await r2.get(key);
      if (!orig.ok) throw new Error(`download ${key} -> ${orig.status}`);
      const len = Number(orig.headers.get('content-length'));
      if (len && len > MAX_ORIGINAL_BYTES)
        throw new Error(`original ${key} too large: ${len} > ${MAX_ORIGINAL_BYTES}`);
      const etag = stripEtagQuotes(orig.headers.get('etag'));
      if (!etag) throw new Error(`original ${key} has no ETag`);
      // Deterministic from the tiler build + the exact original tiled, so a
      // duplicate delivery of the same original lands on the same keys.
      const version = `t${TILER_OUTPUT_VERSION}-${etag}`;
      if (!PANO_PATTERN.test(version))
        throw new Error(`derived tile version must match ${PANO_PATTERN} (got ${version})`);
      const work = await mkdtemp(join(tmpdir(), 'pano-'));
      try {
        // Written outside build()'s output tree, under a name a valid
        // panoId can never take ("." is outside PANO_PATTERN's charset).
        const src = join(work, '.original');
        await writeFile(src, new Uint8Array(await orig.arrayBuffer()));
        await build({
          src,
          outDir: work,
          pano: panoId,
          format: 'webp',
          quality: 70,
          version,
        });
        const files = await walk(join(work, panoId));
        const tilePrefix = tileVersionPrefix(panoId, version);
        const tileKeysOf = (): string[] =>
          Object.keys(files)
            .filter((k) => k !== 'manifest.json')
            .map((k) => tilePrefix + k);

        await uploadDir(files, tilePrefix, put);

        // A newer upload or a delete can supersede this job before the
        // manifest swap; skipping it here is success, not a failure to retry.
        const preHead = await r2.head(key);
        if (!preHead.ok && preHead.status !== 404) {
          throw new Error(`pre-swap HEAD ${key} -> ${preHead.status}`);
        }
        if (!preHead.ok) {
          console.warn(`skip manifest for ${key}: original is gone (HEAD ${preHead.status})`);
          const tileKeys = tileKeysOf();
          await deleteKeys(tileKeys);
          console.warn(
            `deleted ${tileKeys.length} orphaned tile(s) under ${tilePrefix}: original ${key} was deleted mid-job`,
          );
        } else if (stripEtagQuotes(preHead.etag) !== etag) {
          console.warn(
            `skip manifest for ${key}: original ETag changed (${etag} -> ${String(stripEtagQuotes(preHead.etag))})`,
          );
        } else {
          if (files['manifest.json']) {
            await put(manifestKey(panoId), files['manifest.json'], 'application/json');
          }
          // A DELETE can land between the pre-swap HEAD and the manifest PUT;
          // this catches it - a retry won't, since r2.get(key) 404s first.
          const postHead = await r2.head(key);
          if (!postHead.ok) {
            if (postHead.status !== 404)
              throw new Error(`post-PUT HEAD ${key} -> ${postHead.status}`);
            const orphanKeys = [manifestKey(panoId), ...tileKeysOf()];
            await deleteKeys(orphanKeys);
            console.warn(
              `deleted ${orphanKeys.length} post-PUT orphaned key(s) under ${tilePrefix}: original ${key} was deleted mid-job`,
            );
          } else if (stripEtagQuotes(postHead.etag) !== etag) {
            // A newer original landed after the pre-swap check and may have
            // had its manifest overwritten - throw so the retry rewrites it.
            throw new Error(
              `post-PUT HEAD ${key} ETag changed: ${etag} -> ${String(stripEtagQuotes(postHead.etag))}`,
            );
          }
        }
        res.writeHead(200).end('ok');
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
}).listen(8080);
