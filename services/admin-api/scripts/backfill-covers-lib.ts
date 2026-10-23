// Argument handling and the API calls for the operator's cover and Explore backfill CLI
// (backfill-covers.ts). Pure apart from fetch, so the Worker test pool covers it. The work is
// admin-api's operator backfill route (src/backfill.ts): it walks tours/ through the native
// binding, a page per request, so this needs no R2 credentials, only the operator token.
import {
  OPERATOR_BACKFILL_MAX_TOURS,
  OPERATOR_BACKFILL_PATH,
  OPERATOR_TOKEN_HEADER,
  OperatorBackfillOkSchema,
  type OperatorBackfillOk,
} from '@internal/contracts';

import { operatorApiFromEnv } from './delete-account-lib.ts';
import type { FetchLike } from './restore-backup-lib.ts';

export interface BackfillArgs {
  /** False unless --apply: report what each tour needs and change nothing. */
  apply: boolean;
  /** Tours per request. */
  limit: number;
  bucket: string;
  api: { origin: string; token: string };
}

export const USAGE =
  'usage: backfill-covers.ts [--apply] [--limit <1-25>] [--allow-bucket <bucket>]\n' +
  '       Without --apply it only reports what each tour needs. Needs R2_BUCKET (to pick the\n' +
  '       environment) and OPERATOR_TOKEN; ADMIN_API_ORIGIN overrides the origin.';

export function parseBackfillArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): BackfillArgs {
  let apply = false;
  let limit = 10;
  let allowBucket: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--limit' || arg === '--allow-bucket') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--allow-bucket') {
        allowBucket = value;
      } else {
        limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > OPERATOR_BACKFILL_MAX_TOURS) {
          throw new Error(
            `--limit must be a whole number from 1 to ${OPERATOR_BACKFILL_MAX_TOURS}`,
          );
        }
      }
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  const bucket = env.R2_BUCKET;
  if (!bucket) throw new Error('missing env R2_BUCKET (it picks the environment)');
  // The same rule as the other operator scripts: anything but a -dev bucket is named twice.
  if (!bucket.endsWith('-dev') && allowBucket !== bucket) {
    throw new Error(`R2_BUCKET is ${bucket}; pass --allow-bucket ${bucket} to run against it`);
  }
  return { apply, limit, bucket, api: operatorApiFromEnv(env, bucket, allowBucket) };
}

/** One page from admin-api's operator backfill route. */
export async function requestBackfill(
  fetchFn: FetchLike,
  api: { origin: string; token: string },
  body: { cursor?: string; limit: number; apply: boolean },
): Promise<OperatorBackfillOk> {
  const res = await fetchFn(`${api.origin}${OPERATOR_BACKFILL_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [OPERATOR_TOKEN_HEADER]: api.token },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const hint =
      res.status === 404
        ? ' (check OPERATOR_TOKEN matches the admin-api secret in this env, and that admin-api has the backfill route)'
        : '';
    throw new Error(`backfill -> ${res.status}${hint}`);
  }
  const parsed = OperatorBackfillOkSchema.safeParse(json);
  if (!parsed.success) throw new Error('backfill: unexpected response');
  return parsed.data;
}

export interface BackfillDeps {
  fetch: FetchLike;
  log: (line: string) => void;
}

/** The whole CLI run: every page until the route says there are no more tours. */
export async function runBackfill(args: BackfillArgs, deps: BackfillDeps): Promise<number> {
  const totals = { tours: 0, changed: 0, skipped: 0, cover: 0, 'owner-pointer': 0, explore: 0 };
  let cursor: string | undefined;
  do {
    const page = await requestBackfill(deps.fetch, args.api, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit: args.limit,
      apply: args.apply,
    });
    for (const t of page.tours) {
      totals.tours += 1;
      if (t.skipped) {
        totals.skipped += 1;
        deps.log(`skip ${t.tourId}: ${t.skipped}`);
        continue;
      }
      if (t.changes.length === 0) continue;
      totals.changed += 1;
      for (const c of t.changes) totals[c] += 1;
      deps.log(`${args.apply ? '' : 'would '}update ${t.tourId}: ${t.changes.join(', ')}`);
    }
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  deps.log(
    `${totals.tours} tour(s): ${totals.changed} ${args.apply ? 'updated' : 'to update'} (cover ${totals.cover}, owner pointer ${totals['owner-pointer']}, Explore ${totals.explore}), ${totals.skipped} skipped`,
  );
  if (!args.apply) {
    deps.log(`DRY RUN: nothing changed in ${args.bucket}; pass --apply to update them`);
  }
  return 0;
}
