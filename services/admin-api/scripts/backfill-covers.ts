#!/usr/bin/env node
/* eslint-disable no-console -- a CLI; stdout is its interface */
// Backfills what tours saved or published before the current code lack until their owner's
// next Save: the dashboard cover (tour.json's metadata), the owner pointer, and the Explore
// entry and its cover. Idempotent; reports only unless --apply. It calls admin-api's operator
// backfill route, which does the work through the binding. A human runs this by hand; see
// "Cover and Explore backfill" in docs/deploy.md.
//
//   R2_BUCKET=pano-content-dev OPERATOR_TOKEN=... \
//   node services/admin-api/scripts/backfill-covers.ts --apply
import { parseBackfillArgs, runBackfill, USAGE } from './backfill-covers-lib.ts';

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2), process.env);
  process.exitCode = await runBackfill(args, {
    fetch: (input, init) => fetch(input, init),
    log: (line) => console.log(line),
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  console.error(USAGE);
  process.exit(1);
});
