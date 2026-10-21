#!/usr/bin/env node
/* eslint-disable no-console -- a CLI; stdout is its interface */
// Takes down an abusive tour and/or blocks its owner. Tours come down through
// admin-api's operator route (the owner's own unpublish or tour delete, with the
// CDN purge); the owner block is a marker written over the R2 S3 API, which
// admin-api and upload-api check on every write. A human runs this by hand;
// see "Takedown" in docs/deploy.md.
//
//   R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... \
//   R2_SECRET_ACCESS_KEY=... OPERATOR_TOKEN=... \
//   node services/admin-api/scripts/takedown.ts --slug <slug> --unpublish --disable-owner
import { createR2S3Client } from '@internal/worker-kit/r2-s3';

import {
  describeOwner,
  disableOwner,
  enableOwner,
  findTourOwner,
  parseTakedownArgs,
  readOwnerStatus,
  requestTourTakedown,
  tourIdForSlug,
  USAGE,
} from './takedown-lib.ts';

async function main(): Promise<void> {
  const args = parseTakedownArgs(process.argv.slice(2), process.env);
  const r2 = createR2S3Client({ ...args.r2, retries: 3 });

  // Read-only from here to the dry-run stop: find the tour and its owner.
  const tourId = args.slug !== undefined ? await tourIdForSlug(r2, args.slug) : args.tourId;
  const sub = args.sub ?? (tourId !== undefined ? await findTourOwner(r2, tourId) : undefined);
  if (sub === undefined) throw new Error('no owner to act on');
  if (tourId !== undefined) console.log(`tour ${tourId}`);
  console.log(describeOwner(sub, await readOwnerStatus(r2, sub)));

  const planned = [
    args.ownerAction && `${args.ownerAction} owner`,
    args.tourAction && `${args.tourAction} tour via ${args.api?.origin}`,
  ].filter(Boolean);
  if (planned.length === 0) return;
  if (args.dryRun) {
    console.log(`DRY RUN: would ${planned.join(', then ')} in ${args.r2.bucket}`);
    return;
  }

  // Owner first: a disabled owner can't republish while the tour comes down.
  if (args.ownerAction === 'disable') {
    await disableOwner(r2, sub, new Date(), args.reason);
    console.log('owner disabled: uploads and admin writes now answer 403');
  } else if (args.ownerAction === 'enable') {
    await enableOwner(r2, sub);
    console.log('owner enabled again');
  }
  if (args.tourAction && tourId !== undefined && args.api) {
    const done = await requestTourTakedown((input, init) => fetch(input, init), args.api, {
      sub,
      tourId,
      action: args.tourAction,
    });
    console.log(`tour ${done.action}d; ${done.purged} CDN purge target(s) queued`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  console.error(USAGE);
  process.exit(1);
});
