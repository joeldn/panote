#!/usr/bin/env node
/* eslint-disable no-console -- a CLI; stdout is its interface */
// Gives panos tiled before og.jpg existed a link-preview image. A human runs
// this by hand against dev; see "Link-preview image backfill" in docs/deploy.md.
//
//   R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... \
//   R2_SECRET_ACCESS_KEY=... node services/tiler-consumer/dist/backfill-og.js --dry-run
import { backfillOg, setVipsConcurrency, type OgStore } from '@internal/tiler';
import { createR2S3Client } from '@internal/worker-kit/r2-s3';
import { manifestKey, TILES_ROOT, tilesPrefix, tileVersionPrefix } from '@internal/contracts';
import { panoIdsFromPrefixes, parseBackfillArgs } from './backfill-args.js';

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2), process.env);
  setVipsConcurrency(4);
  const r2 = createR2S3Client({ ...args.r2, retries: 3 });
  const store: OgStore = {
    async get(key) {
      const res = await r2.get(key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${key} -> ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    put: (key, body, contentType, cacheControl) => r2.put(key, body, { contentType, cacheControl }),
  };
  const panos = args.panos ?? panoIdsFromPrefixes(await r2.listPrefixes(TILES_ROOT));
  console.log(
    `${args.dryRun ? 'DRY RUN: ' : ''}${panos.length} pano(s) in ${args.r2.bucket}${args.dryRun ? ', nothing will be written' : ''}`,
  );
  const results = await backfillOg({
    store,
    keys: {
      manifest: manifestKey,
      versionDir: (pano, version) =>
        version === undefined ? tilesPrefix(pano) : tileVersionPrefix(pano, version),
    },
    panos,
    dryRun: args.dryRun,
    log: (line) => console.log(line),
  });
  const count = (s: string) => results.filter((r) => r.status === s).length;
  console.log(
    `done: ${count('rendered')} rendered, ${count('would-render')} would render, ${count('skipped')} skipped, ${count('failed')} failed`,
  );
  if (count('failed')) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
