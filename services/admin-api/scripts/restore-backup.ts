#!/usr/bin/env node
/* eslint-disable no-console -- a CLI; stdout is its interface */
// Restores tour and config JSON, and floor-plan images, from admin-api's daily backup (backup/<YYYY-MM-DD>/):
// one tour, one owner, or everything. It plans over the R2 S3 API and writes through
// admin-api's operator restore route, create-only unless --overwrite. A human runs this
// by hand; see "Backups" in docs/deploy.md. Lists only, unless --apply.
//
//   R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... \
//   R2_SECRET_ACCESS_KEY=... OPERATOR_TOKEN=... \
//   node services/admin-api/scripts/restore-backup.ts --date 2026-10-21 --tour <tourId> --apply
import { createR2S3Client } from '@internal/worker-kit/r2-s3';

import { parseRestoreArgs, runRestore, USAGE } from './restore-backup-lib.ts';

async function main(): Promise<void> {
  const args = parseRestoreArgs(process.argv.slice(2), process.env);
  process.exitCode = await runRestore(args, {
    store: createR2S3Client({ ...args.r2, retries: 3 }),
    fetch: (input, init) => fetch(input, init),
    log: (line) => console.log(line),
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  console.error(USAGE);
  process.exit(1);
});
