#!/usr/bin/env node
/* eslint-disable no-console -- a CLI; stdout is its interface */
// Re-tiles panos without touching their originals: it puts the same message on
// the upload queue that R2's object-create notification would, and
// tiler-consumer takes it from there. For a TILER_OUTPUT_VERSION bump, or to
// retry panos after a tiler fix. A human runs this by hand; see "Re-tiling" in
// docs/deploy.md. Lists only, unless --apply.
//
//   R2_ACCOUNT_ID=... R2_BUCKET=pano-content-dev R2_ACCESS_KEY_ID=... \
//   R2_SECRET_ACCESS_KEY=... CF_QUEUES_TOKEN=... \
//   node services/admin-api/scripts/retile.ts --pano <panoId> --apply
import { createR2S3Client } from '@internal/worker-kit/r2-s3';

import {
  currentEtag,
  findTargets,
  notificationFor,
  parseRetileArgs,
  resolveQueueId,
  sendToQueue,
  USAGE,
} from './retile-lib.ts';

async function main(): Promise<void> {
  const args = parseRetileArgs(process.argv.slice(2), process.env);
  const r2 = createR2S3Client({ ...args.r2, retries: 3 });

  // Every object under panos/: the owner is only in the key, so a panoId alone
  // can't be looked up any other way.
  const { targets, deleting, missing } = findTargets(await r2.listObjects('panos/'), args.panos);
  for (const p of missing) console.log(`skip ${p}: no original`);
  for (const p of deleting) console.log(`skip ${p}: being deleted`);

  const now = new Date();
  const bodies: unknown[] = [];
  for (const t of targets) {
    const etag = await currentEtag(r2, t.key);
    if (etag === null) {
      console.log(`skip ${t.panoId}: original gone since the listing`);
      continue;
    }
    bodies.push(notificationFor(t, etag, args.r2, now));
    console.log(`${args.apply ? 'queue' : 'would queue'} ${t.panoId} (${t.size} bytes)`);
  }

  if (!args.apply) {
    console.log(
      `DRY RUN: ${bodies.length} pano(s) would go on ${args.queue}; pass --apply to send them`,
    );
    return;
  }
  if (bodies.length === 0) return;
  const queueId = await resolveQueueId(fetch, args.r2.accountId, args.apiToken!, args.queue);
  const sent = await sendToQueue(fetch, args.r2.accountId, args.apiToken!, queueId, bodies);
  console.log(`queued ${sent} pano(s) on ${args.queue}; tiler-consumer works through them`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  console.error(USAGE);
  process.exit(1);
});
