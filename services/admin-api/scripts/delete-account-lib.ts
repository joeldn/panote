// Argument handling and marker logic for the operator's account-delete CLI
// (delete-account.ts). Pure apart from the store, so the Worker test pool covers it.
import {
  accountDeletionKey,
  AccountDeletionRecordSchema,
  type AccountDeletionRecord,
} from '@internal/contracts';
import type { R2S3Client } from '@internal/worker-kit/r2-s3';

export type Mode = 'request' | 'dry-run' | 'status';

export interface DeleteAccountArgs {
  mode: Mode;
  sub: string;
  r2: { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string };
}

const ENV_NAMES = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

export const USAGE =
  'usage: delete-account.ts --sub <auth0 user id> [--dry-run | --status] [--allow-bucket <bucket>]';

export function parseDeleteAccountArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): DeleteAccountArgs {
  let mode: Mode = 'request';
  let sub: string | undefined;
  let allowBucket: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run' || arg === '--status') {
      if (mode !== 'request') throw new Error('--dry-run and --status are exclusive');
      mode = arg === '--dry-run' ? 'dry-run' : 'status';
      continue;
    }
    if (arg === '--sub' || arg === '--allow-bucket') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--sub') sub = value;
      else allowBucket = value;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  // The Auth0 user id, e.g. google-oauth2|1234 (Auth0 dashboard: User Management > Users).
  if (!sub?.trim()) throw new Error('--sub is required');

  const missing = ENV_NAMES.filter((n) => !env[n]);
  if (missing.length) throw new Error(`missing env ${missing.join(', ')}`);
  const bucket = env.R2_BUCKET!;
  // Same guard as the og.jpg backfill: anything but a -dev bucket is named twice.
  if (!bucket.endsWith('-dev') && allowBucket !== bucket) {
    throw new Error(`R2_BUCKET is ${bucket}; pass --allow-bucket ${bucket} to run against it`);
  }
  return {
    mode,
    sub,
    r2: {
      accountId: env.R2_ACCOUNT_ID!,
      bucket,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  };
}

export type MarkerStore = Pick<R2S3Client, 'get' | 'head' | 'put'>;

/** The marker as admin-api wrote it, or null when there is none (or it's unreadable). */
export async function readAccountDeletion(
  store: MarkerStore,
  sub: string,
): Promise<AccountDeletionRecord | null> {
  const res = await store.get(accountDeletionKey(sub));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GET -> ${res.status}`);
  const parsed = AccountDeletionRecordSchema.safeParse(await res.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/**
 * Marks the account exactly as the owner's own DELETE /api/admin/account does:
 * from then on admin-api refuses its writes, and its daily sweep deletes
 * everything and keeps re-sweeping for 30 days. An existing marker is kept.
 */
export async function requestAccountDeletion(
  store: MarkerStore,
  sub: string,
  now: Date,
): Promise<{ created: boolean; record: AccountDeletionRecord | null }> {
  const head = await store.head(accountDeletionKey(sub));
  if (head.ok) return { created: false, record: await readAccountDeletion(store, sub) };
  if (head.status !== 404) throw new Error(`R2 HEAD -> ${head.status}`);
  const record: AccountDeletionRecord = { v: 1, sub, requestedAt: now.toISOString() };
  await store.put(accountDeletionKey(sub), JSON.stringify(record), {
    contentType: 'application/json',
  });
  return { created: true, record };
}

/** One line for the operator; says where the deletion is, never more than that. */
export function describeAccountDeletion(record: AccountDeletionRecord | null): string {
  if (!record) return 'no deletion requested for this account';
  if (!record.completedAt) {
    return `deletion requested ${record.requestedAt}; the next daily sweep (03:17 UTC) deletes everything`;
  }
  return `deleted ${record.completedAt} (requested ${record.requestedAt}); swept daily for 30 days after that`;
}
