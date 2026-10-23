#!/usr/bin/env node
/* eslint-disable no-console -- a CLI; stdout is its interface */
// Takes down an abusive tour (or every tour an owner has) and/or blocks its owner.
// Tours come down through admin-api's operator route (the owner's own unpublish or
// tour delete, with the CDN purge by URL); then a sample is fetched back from the CDN
// to check it's gone (exit code 2 if it still serves any). --quarantine first copies
// the content to a private quarantine/<caseId>/ prefix, for evidence. The owner block is a marker
// written over the R2 S3 API, which admin-api and upload-api check on every write.
// A human runs this by hand; see "Takedown" in docs/deploy.md.
//
//   R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... \
//   R2_SECRET_ACCESS_KEY=... OPERATOR_TOKEN=... \
//   node services/admin-api/scripts/takedown.ts --slug <slug> --unpublish --disable-owner
import { createR2S3Client } from '@internal/worker-kit/r2-s3';

import { parseTakedownArgs, runTakedown, USAGE } from './takedown-lib.ts';

async function main(): Promise<void> {
  const args = parseTakedownArgs(process.argv.slice(2), process.env);
  const result = await runTakedown(args, {
    store: createR2S3Client({ ...args.r2, retries: 3 }),
    fetch: (input, init) => fetch(input, init),
    log: (line) => console.log(line),
    now: () => new Date(),
  });
  // Done, but the CDN still serves some of it: not a clean exit.
  if (result.cdnStillServed.length > 0) process.exitCode = 2;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  console.error(USAGE);
  process.exit(1);
});
