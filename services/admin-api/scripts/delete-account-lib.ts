// Argument handling and marker logic for the operator's account-delete CLI
// (delete-account.ts). Pure apart from the store, so the Worker test pool covers it.
import {
  ACCOUNTS_ROOT,
  accountDeletionKey,
  AccountDeletionRecordSchema,
  type AccountDeletionRecord,
} from '@internal/contracts';
import { R2PreconditionFailedError, type R2S3Client } from '@internal/worker-kit/r2-s3';

export type Mode = 'request' | 'dry-run' | 'status' | 'list';

export interface DeleteAccountArgs {
  mode: Mode;
  /** Empty for --list, which covers every account. */
  sub: string;
  r2: { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string };
}

const ENV_NAMES = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

export const USAGE =
  'usage: delete-account.ts (--sub <auth0 user id> [--dry-run | --status] | --list) [--allow-bucket <bucket>]';

const MODE_FLAGS: Record<string, Mode> = {
  '--dry-run': 'dry-run',
  '--status': 'status',
  '--list': 'list',
};

export function parseDeleteAccountArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): DeleteAccountArgs {
  let mode: Mode = 'request';
  let sub: string | undefined;
  let allowBucket: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const flagMode = MODE_FLAGS[arg];
    if (flagMode) {
      if (mode !== 'request') throw new Error('--dry-run, --status and --list are exclusive');
      mode = flagMode;
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
  if (mode === 'list') {
    if (sub !== undefined) throw new Error('--list covers every account; drop --sub');
  } else if (!sub?.trim()) {
    throw new Error('--sub is required');
  } else if (sub !== sub.trim()) {
    // A pasted id with a stray space would mark an account nobody has.
    throw new Error('--sub has leading or trailing whitespace');
  }

  const missing = ENV_NAMES.filter((n) => !env[n]);
  if (missing.length) throw new Error(`missing env ${missing.join(', ')}`);
  const bucket = env.R2_BUCKET!;
  // Same guard as the og.jpg backfill: anything but a -dev bucket is named twice.
  if (!bucket.endsWith('-dev') && allowBucket !== bucket) {
    throw new Error(`R2_BUCKET is ${bucket}; pass --allow-bucket ${bucket} to run against it`);
  }
  return {
    mode,
    sub: sub ?? '',
    r2: {
      accountId: env.R2_ACCOUNT_ID!,
      bucket,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  };
}

export type MarkerStore = Pick<R2S3Client, 'get' | 'head' | 'put' | 'listPrefixes'>;

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
  const existing = async () => ({ created: false, record: await readAccountDeletion(store, sub) });
  const head = await store.head(accountDeletionKey(sub));
  if (head.ok) return existing();
  if (head.status !== 404) throw new Error(`R2 HEAD -> ${head.status}`);
  const record: AccountDeletionRecord = { v: 1, sub, requestedAt: now.toISOString() };
  try {
    // Create-only, like the owner route's write: a marker that appeared since the
    // HEAD (the owner deleting at the same moment) is kept as it is.
    await store.put(accountDeletionKey(sub), JSON.stringify(record), {
      contentType: 'application/json',
      ifNoneMatch: '*',
    });
  } catch (e) {
    if (e instanceof R2PreconditionFailedError) return existing();
    throw e;
  }
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

const DAY_MS = 24 * 60 * 60 * 1000;
// The UI and privacy page promise the sign-in record goes within 30 days of the request.
export const AUTH0_REMOVAL_DAYS = 30;

/** Every marker in the bucket, oldest request first; unreadable ones are skipped. */
export async function listAccountDeletions(store: MarkerStore): Promise<AccountDeletionRecord[]> {
  const records: AccountDeletionRecord[] = [];
  for (const prefix of await store.listPrefixes(ACCOUNTS_ROOT)) {
    const res = await store.get(`${prefix}deletion.json`);
    if (!res.ok) continue;
    const parsed = AccountDeletionRecordSchema.safeParse(await res.json().catch(() => null));
    if (parsed.success) records.push(parsed.data);
  }
  return records.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** One tab-separated line per marker: sub, requested, completed, Auth0 removal due by. */
export function formatAccountDeletions(records: readonly AccountDeletionRecord[]): string[] {
  return [
    'sub\trequestedAt\tcompletedAt\tauth0RemovalDueBy',
    ...records.map((r) =>
      [
        r.sub,
        r.requestedAt,
        r.completedAt ?? '-',
        new Date(Date.parse(r.requestedAt) + AUTH0_REMOVAL_DAYS * DAY_MS).toISOString(),
      ].join('\t'),
    ),
  ];
}
