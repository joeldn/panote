#!/usr/bin/env node
/* eslint-disable no-console -- a CLI; stdout is its interface */
// Lists every account with its tour count, pano count and bytes (originals, the quota's
// figure; trash; tiles with --tiles), read from R2 listings. Read-only: it lists keys over
// the R2 S3 API and reads or writes no object. See "Operator: account storage" in
// docs/deploy.md.
//
//   R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... \
//   R2_SECRET_ACCESS_KEY=... node services/admin-api/scripts/account-storage.ts --top 20
import { createR2S3Client } from '@internal/worker-kit/r2-s3';

import { parseStorageArgs, runStorage, USAGE } from './account-storage-lib.ts';

async function main(): Promise<void> {
  const args = parseStorageArgs(process.argv.slice(2), process.env);
  process.exitCode = await runStorage(args, {
    store: createR2S3Client({ ...args.r2, retries: 3 }),
    log: (line) => console.log(line),
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  console.error(USAGE);
  process.exit(1);
});
