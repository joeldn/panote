#!/usr/bin/env node
/* eslint-disable no-console -- a CLI; stdout is its interface */
// Takes down an abusive tour (or every tour an owner has) and/or blocks its owner.
// Tours come down through admin-api's operator route (the owner's own unpublish or
// tour delete, with the CDN purge). --quarantine first copies the content to a
// private quarantine/<caseId>/ prefix, for evidence. The owner block is a marker
// written over the R2 S3 API, which admin-api and upload-api check on every write.
// A human runs this by hand; see "Takedown" in docs/deploy.md.
//
//   R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... \
//   R2_SECRET_ACCESS_KEY=... OPERATOR_TOKEN=... \
//   node services/admin-api/scripts/takedown.ts --slug <slug> --unpublish --disable-owner
import { createR2S3Client } from '@internal/worker-kit/r2-s3';

import { requestAccountDeletion } from './delete-account-lib.ts';
import {
  assertOwnsTour,
  copyToQuarantine,
  describeOwner,
  disableOwner,
  enableOwner,
  findTourOwner,
  listOwnerTours,
  ownerPanoContent,
  panosWithTiles,
  parseTakedownArgs,
  quarantineKey,
  readOwnerStatus,
  requestTourTakedown,
  tourContent,
  tourIdForSlug,
  USAGE,
  writeCaseRecord,
} from './takedown-lib.ts';

async function main(): Promise<void> {
  const args = parseTakedownArgs(process.argv.slice(2), process.env);
  const r2 = createR2S3Client({ ...args.r2, retries: 3 });

  // Read-only from here to the dry-run stop: find the tour(s) and the owner.
  const tourId = args.slug !== undefined ? await tourIdForSlug(r2, args.slug) : args.tourId;
  const sub = args.sub ?? (tourId !== undefined ? await findTourOwner(r2, tourId) : undefined);
  if (sub === undefined) throw new Error('no owner to act on');
  // A --sub given with a tour must be that tour's owner, before anything is written.
  if (args.sub !== undefined && tourId !== undefined) await assertOwnsTour(r2, sub, tourId);
  if (tourId !== undefined) console.log(`tour ${tourId}`);
  console.log(describeOwner(sub, await readOwnerStatus(r2, sub)));
  const tourIds = args.allTours ? await listOwnerTours(r2, sub) : tourId ? [tourId] : [];
  if (args.allTours) console.log(`owner has ${tourIds.length} tour(s): ${tourIds.join(', ')}`);

  const planned = [
    args.ownerAction && `${args.ownerAction} owner`,
    args.tourAction === 'quarantine' &&
      `copy ${args.allTours ? 'everything the owner has' : 'the tour'} to ${quarantineKey(args.caseId!, '')}`,
    args.tourAction &&
      tourIds.length > 0 &&
      `${args.tourAction === 'unpublish' ? 'unpublish' : 'delete'} ${tourIds.length} tour(s) via ${args.api?.origin}`,
    args.closeAccount && 'mark the account for deletion',
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

  // Quarantine: every copy is made, and the case record written, before anything is removed.
  const panoIds = new Set<string>();
  if (args.tourAction === 'quarantine') {
    const caseId = args.caseId!;
    const keys = new Set<string>();
    for (const id of tourIds) {
      const content = await tourContent(r2, sub, id);
      content.keys.forEach((k) => keys.add(k));
      content.panoIds.forEach((p) => panoIds.add(p));
    }
    if (args.allTours) {
      const content = await ownerPanoContent(r2, sub);
      content.keys.forEach((k) => keys.add(k));
      content.panoIds.forEach((p) => panoIds.add(p));
    }
    const copied: string[] = [];
    for (const key of keys) if (await copyToQuarantine(r2, caseId, key)) copied.push(key);
    await writeCaseRecord(
      r2,
      caseId,
      { sub, tourIds, keys: copied, reason: args.reason },
      new Date(),
    );
    console.log(
      `${copied.length} object(s) copied to ${quarantineKey(caseId, '')} (case.json lists them)`,
    );
  }

  if (args.tourAction && args.api) {
    const action = args.tourAction === 'unpublish' ? 'unpublish' : 'delete';
    // One at a time: each delete checks which panos the owner's other tours still use.
    for (const id of tourIds) {
      const done = await requestTourTakedown((input, init) => fetch(input, init), args.api, {
        sub,
        tourId: id,
        action,
      });
      console.log(`tour ${id} ${done.action}d; ${done.purged} CDN purge target(s) queued`);
    }
    if (action === 'unpublish') {
      console.log('panos and their tiles are kept; use --quarantine to remove them as well');
    }
  }

  if (args.closeAccount) {
    const { created } = await requestAccountDeletion(r2, sub, new Date());
    console.log(
      created
        ? 'account marked for deletion: the next daily sweep deletes what is left, with its tiles'
        : 'account was already marked for deletion',
    );
  }

  // Tiles live under the panoId, not the owner: say which ones are still public.
  const tiled = await panosWithTiles(r2, [...panoIds]);
  if (tiled.length > 0) {
    console.log(
      `tiles still public for ${tiled.length} pano(s): ${tiled.join(', ')}` +
        (args.closeAccount
          ? ' (the account-deletion sweep removes them)'
          : " (another of the owner's tours uses them; --all-tours takes those down too)"),
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  console.error(USAGE);
  process.exit(1);
});
