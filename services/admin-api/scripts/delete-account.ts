#!/usr/bin/env node
/* eslint-disable no-console -- a CLI; stdout is its interface */
// Deletes a Panote account on request, by the same path as the owner's own
// "Delete account": it writes the deletion marker and admin-api's daily sweep
// does the rest (tours, slugs, panos, tiles, stats). A human runs this by hand;
// see "Account deletion" in docs/deploy.md.
//
//   R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... \
//   R2_SECRET_ACCESS_KEY=... node services/admin-api/scripts/delete-account.ts --sub '<auth0 id>'
import { accountDeletionKey } from '@internal/contracts';
import { createR2S3Client } from '@internal/worker-kit/r2-s3';

import {
  describeAccountDeletion,
  formatAccountDeletions,
  listAccountDeletions,
  parseDeleteAccountArgs,
  readAccountDeletion,
  requestAccountDeletion,
  USAGE,
} from './delete-account-lib.ts';

async function main(): Promise<void> {
  const args = parseDeleteAccountArgs(process.argv.slice(2), process.env);
  if (args.mode === 'dry-run') {
    console.log(`DRY RUN: would write ${accountDeletionKey(args.sub)} in ${args.r2.bucket}`);
    return;
  }
  const r2 = createR2S3Client({ ...args.r2, retries: 3 });
  if (args.mode === 'list') {
    // The weekly check (docs/deploy.md): every account whose Auth0 user may still need removing.
    for (const line of formatAccountDeletions(await listAccountDeletions(r2))) console.log(line);
    return;
  }
  if (args.mode === 'status') {
    console.log(describeAccountDeletion(await readAccountDeletion(r2, args.sub)));
    return;
  }
  const { created, record } = await requestAccountDeletion(r2, args.sub, new Date());
  console.log(created ? 'marked for deletion' : 'already marked, left as it was');
  console.log(describeAccountDeletion(record));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  console.error(USAGE);
  process.exit(1);
});
