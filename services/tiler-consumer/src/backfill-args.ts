// Argument and env handling for the og.jpg backfill CLI (src/backfill-og.ts).
// Pure, so the Worker test pool can cover it without loading sharp.
import { PANO_PATTERN, TILES_ROOT } from '@internal/contracts';

export interface BackfillArgs {
  dryRun: boolean;
  /** null: every pano under tiles/. */
  panos: string[] | null;
  r2: { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string };
}

const ENV_NAMES = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

export function parseBackfillArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): BackfillArgs {
  let dryRun = false;
  let allowBucket: string | undefined;
  const panos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--pano' || arg === '--allow-bucket') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--allow-bucket') allowBucket = value;
      else if (!PANO_PATTERN.test(value)) throw new Error(`pano must match ${PANO_PATTERN}`);
      else panos.push(value);
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }

  const missing = ENV_NAMES.filter((n) => !env[n]);
  if (missing.length) throw new Error(`missing env ${missing.join(', ')}`);
  const bucket = env.R2_BUCKET!;
  // A guard against pointing this at production by accident: anything but a
  // -dev bucket has to be named twice.
  if (!bucket.endsWith('-dev') && allowBucket !== bucket)
    throw new Error(`R2_BUCKET is ${bucket}; pass --allow-bucket ${bucket} to run against it`);

  return {
    dryRun,
    panos: panos.length ? panos : null,
    r2: {
      accountId: env.R2_ACCOUNT_ID!,
      bucket,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  };
}

/** `tiles/<pano>/` listing prefixes to pano ids; anything else is dropped. */
export function panoIdsFromPrefixes(prefixes: readonly string[]): string[] {
  return prefixes
    .filter((p) => p.startsWith(TILES_ROOT) && p.endsWith('/'))
    .map((p) => p.slice(TILES_ROOT.length, -1))
    .filter((id) => PANO_PATTERN.test(id));
}
