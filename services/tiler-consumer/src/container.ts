// The container entrypoint (runs on Node inside the image, CMD ["node", "dist/container.js"]).
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { manifestKey, parseOwnerFromKey } from '@internal/contracts';
import { build } from '@internal/tiler';
import { createR2S3Client } from '@internal/worker-kit/r2-s3';
import { uploadDir, type PutFn } from './r2io.js';

// TODO(commit 11): every one of these is read from `process.env` at MODULE
// SCOPE, but nothing currently supplies them to this process - the Tiler DO
// (src/consumer.ts) never sets `envVars`, and wrangler's `[[containers]]`
// block only carries build-time `image_vars`, never a runtime env. Right
// now each of R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID /
// R2_SECRET_ACCESS_KEY is `undefined`, so this client is built against
// `https://undefined.r2.cloudflarestorage.com/undefined` and every tile job
// fails: the consumer retries, and after max_retries it lands in the DLQ -
// silently, because the upload itself succeeded and the pano just never
// becomes ready. This is a pre-existing bug in the source (pano-viewer),
// ported here faithfully and not fixed - the next commit forwards the
// credentials through `Container.envVars` and fails fast here instead of
// building an undefined URL.
const r2 = createR2S3Client({
  accountId: process.env.R2_ACCOUNT_ID!,
  bucket: process.env.R2_BUCKET!,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
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
      const owner = parseOwnerFromKey(key);
      if (!owner) throw new Error(`bad key ${key}`);
      const orig = await r2.get(key);
      if (!orig.ok) throw new Error(`download ${key} -> ${orig.status}`);
      const len = Number(orig.headers.get('content-length'));
      if (len && len > MAX_ORIGINAL_BYTES)
        throw new Error(`original ${key} too large: ${len} > ${MAX_ORIGINAL_BYTES}`);
      const work = await mkdtemp(join(tmpdir(), 'pano-'));
      try {
        const src = join(work, 'src');
        await writeFile(src, new Uint8Array(await orig.arrayBuffer()));
        await build({
          src,
          outDir: work,
          pano: owner.panoId,
          format: 'webp',
          quality: 70,
        });
        const files = await walk(join(work, owner.panoId));
        await uploadDir(
          files,
          manifestKey(owner.userId, owner.panoId).replace(/manifest\.json$/, ''),
          put,
        );
        res.writeHead(200).end('ok');
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
}).listen(8080);
