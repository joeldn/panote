// Argument handling and the report for the operator's account storage CLI
// (account-storage.ts). Read-only: it only lists keys over the R2 S3 API (no GET of any
// object, no write), so it is safe to run at any time. Pure apart from the store, so the
// Worker test pool covers it.
import { decodeId, TILES_ROOT, TRASH_ROOT } from '@internal/contracts';
import type { R2ListedObject, R2S3Client } from '@internal/worker-kit/r2-s3';

import { r2ConfigFromEnv, type R2Config } from './delete-account-lib.ts';

export interface StorageArgs {
  format: 'table' | 'json';
  /** Also list every tile (one more listing of all of tiles/), to count each owner's tile bytes. */
  tiles: boolean;
  /** Only this many accounts, largest first; null for all. */
  top: number | null;
  r2: R2Config;
}

export const USAGE =
  'usage: account-storage.ts [--json] [--tiles] [--top <n>] [--allow-bucket <bucket>]\n' +
  '       Lists every account with its tours, panos and bytes. Read-only: it only lists keys.';

export function parseStorageArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): StorageArgs {
  let format: StorageArgs['format'] = 'table';
  let tiles = false;
  let top: number | null = null;
  let allowBucket: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') {
      format = 'json';
    } else if (arg === '--tiles') {
      tiles = true;
    } else if (arg === '--top' || arg === '--allow-bucket') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--allow-bucket') {
        allowBucket = value;
      } else {
        top = Number(value);
        if (!Number.isInteger(top) || top < 1) throw new Error('--top must be a whole number');
      }
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return { format, tiles, top, r2: r2ConfigFromEnv(env, allowBucket) };
}

export interface AccountStorage {
  /** The Auth0 user id, decoded from the owner segment; null if the segment isn't one. */
  sub: string | null;
  /** The owner segment of the keys (base64url of the sub). */
  owner: string;
  tours: number;
  /** Panos that count toward the quota: a directory with no delete tombstone. */
  panos: number;
  /** Bytes of those panos' originals: what the storage quota counts. */
  originalBytes: number;
  /** Everything under panos/<owner>/ (originals, configs, markers). */
  panoBytes: number;
  /** Everything under tours/<owner>/ (tour.json, publish.json). */
  tourBytes: number;
  /** Deleted originals waiting in trash/ (not counted toward the quota). */
  trashBytes: number;
  /** Tiles of the owner's panos, with --tiles; null without. */
  tileBytes: number | null;
  deleted: boolean;
  disabled: boolean;
}

export type StorageStore = Pick<R2S3Client, 'listObjects'>;

const PANO_RE = /^panos\/([^/]+)\/([^/]+)\/(.+)$/;
const TOUR_RE = /^tours\/([^/]+)\/([^/]+)\/(.+)$/;
const ACCOUNT_RE = /^accounts\/([^/]+)\/(deletion|disabled)\.json$/;
const TRASH_RE = /^trash\/[^/]+\/panos\/([^/]+)\//;
const TILE_RE = /^tiles\/([^/]+)\//;

/** Every account the bucket has anything for, largest (quota bytes, then all bytes) first. */
export async function accountStorage(
  store: StorageStore,
  withTiles: boolean,
): Promise<AccountStorage[]> {
  const [panos, tours, accounts, trash, tiles] = await Promise.all([
    store.listObjects('panos/'),
    store.listObjects('tours/'),
    store.listObjects('accounts/'),
    store.listObjects(TRASH_ROOT),
    withTiles ? store.listObjects(TILES_ROOT) : Promise.resolve([] as R2ListedObject[]),
  ]);
  const byOwner = new Map<string, AccountStorage>();
  const of = (owner: string): AccountStorage => {
    let a = byOwner.get(owner);
    if (!a) {
      a = {
        sub: decodeId(owner),
        owner,
        tours: 0,
        panos: 0,
        originalBytes: 0,
        panoBytes: 0,
        tourBytes: 0,
        trashBytes: 0,
        tileBytes: withTiles ? 0 : null,
        deleted: false,
        disabled: false,
      };
      byOwner.set(owner, a);
    }
    return a;
  };

  // panoId -> { owner, original size, tombstoned }
  const panoInfo = new Map<string, { owner: string; original: number; deleting: boolean }>();
  for (const o of panos) {
    const m = PANO_RE.exec(o.key);
    if (!m) continue;
    const [, owner, panoId, rest] = m;
    of(owner!).panoBytes += o.size;
    const id = `${owner}/${panoId}`;
    const info = panoInfo.get(id) ?? { owner: owner!, original: 0, deleting: false };
    if (rest === 'original') info.original = o.size;
    if (rest === 'deleting') info.deleting = true;
    panoInfo.set(id, info);
  }
  const tileOwner = new Map<string, string>();
  for (const [id, info] of panoInfo) {
    tileOwner.set(id.slice(id.indexOf('/') + 1), info.owner);
    // The same rule as upload-api's quota: a tombstoned pano counts toward neither limit.
    if (info.deleting) continue;
    const a = of(info.owner);
    a.panos += 1;
    a.originalBytes += info.original;
  }
  for (const o of tours) {
    const m = TOUR_RE.exec(o.key);
    if (!m) continue;
    const a = of(m[1]!);
    a.tourBytes += o.size;
    if (m[3] === 'tour.json') a.tours += 1;
  }
  for (const o of accounts) {
    const m = ACCOUNT_RE.exec(o.key);
    if (!m) continue;
    if (m[2] === 'deletion') of(m[1]!).deleted = true;
    else of(m[1]!).disabled = true;
  }
  for (const o of trash) {
    const m = TRASH_RE.exec(o.key);
    if (m) of(m[1]!).trashBytes += o.size;
  }
  for (const o of tiles) {
    const owner = tileOwner.get(TILE_RE.exec(o.key)?.[1] ?? '');
    if (owner !== undefined) of(owner).tileBytes! += o.size;
  }
  const total = (a: AccountStorage) =>
    a.panoBytes + a.tourBytes + a.trashBytes + (a.tileBytes ?? 0);
  return [...byOwner.values()].sort(
    (a, b) =>
      b.originalBytes - a.originalBytes || total(b) - total(a) || a.owner.localeCompare(b.owner),
  );
}

const human = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  return u === 0 ? `${n} B` : `${n.toFixed(1)} ${units[u]}`;
};

/** The table the CLI prints by default: one row per account, then a totals row. */
export function formatTable(rows: readonly AccountStorage[], withTiles: boolean): string[] {
  const head = [
    'account',
    'tours',
    'panos',
    'originals',
    'trash',
    ...(withTiles ? ['tiles'] : []),
    'state',
  ];
  const body = rows.map((a) => [
    a.sub ?? `(segment ${a.owner})`,
    String(a.tours),
    String(a.panos),
    human(a.originalBytes),
    human(a.trashBytes),
    ...(withTiles ? [human(a.tileBytes ?? 0)] : []),
    [a.deleted ? 'deleted' : '', a.disabled ? 'disabled' : ''].filter(Boolean).join(',') || '-',
  ]);
  const sum = (f: (a: AccountStorage) => number) => rows.reduce((n, a) => n + f(a), 0);
  body.push([
    `${rows.length} account(s)`,
    String(sum((a) => a.tours)),
    String(sum((a) => a.panos)),
    human(sum((a) => a.originalBytes)),
    human(sum((a) => a.trashBytes)),
    ...(withTiles ? [human(sum((a) => a.tileBytes ?? 0))] : []),
    '',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const line = (r: string[]) =>
    r
      .map((c, i) =>
        i === 0 || i === r.length - 1 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!),
      )
      .join('  ')
      .trimEnd();
  return [line(head), ...body.map(line)];
}

export interface StorageDeps {
  store: StorageStore;
  log: (line: string) => void;
}

/** The whole CLI run. */
export async function runStorage(args: StorageArgs, deps: StorageDeps): Promise<number> {
  const all = await accountStorage(deps.store, args.tiles);
  const rows = args.top === null ? all : all.slice(0, args.top);
  if (args.format === 'json') {
    deps.log(JSON.stringify({ bucket: args.r2.bucket, accounts: rows }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    deps.log(`no accounts in ${args.r2.bucket}`);
    return 0;
  }
  for (const line of formatTable(rows, args.tiles)) deps.log(line);
  if (args.top !== null && all.length > rows.length) {
    deps.log(`(the ${rows.length} largest of ${all.length} accounts; drop --top for all)`);
  }
  return 0;
}
