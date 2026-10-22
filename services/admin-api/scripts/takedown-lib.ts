// Argument handling and the R2/API steps for the operator's takedown CLI
// (takedown.ts). Pure apart from the store and fetch, so the Worker test pool covers it.
import {
  accountDeletionKey,
  accountDisabledKey,
  AccountDisabledRecordSchema,
  encodeId,
  OPERATOR_TAKEDOWN_PATH,
  OPERATOR_TOKEN_HEADER,
  OperatorTakedownOkSchema,
  PANO_PATTERN,
  SlugRecordSchema,
  storedSlugKey,
  type AccountDisabledRecord,
  type OperatorTakedownAction,
  type OperatorTakedownOk,
} from '@internal/contracts';
import type { R2S3Client } from '@internal/worker-kit/r2-s3';

import { r2ConfigFromEnv, type R2Config } from './delete-account-lib.ts';

export type OwnerAction = 'disable' | 'enable';

export interface TakedownArgs {
  slug: string | undefined;
  tourId: string | undefined;
  sub: string | undefined;
  tourAction: OperatorTakedownAction | undefined;
  ownerAction: OwnerAction | undefined;
  reason: string | undefined;
  dryRun: boolean;
  r2: R2Config;
  /** admin-api's operator route; only set (and required) for a tour action. */
  api: { origin: string; token: string } | undefined;
}

export const USAGE =
  'usage: takedown.ts (--slug <slug> | --tour <tourId>) [--sub <auth0 user id>]\n' +
  '         [--unpublish | --delete | --hide-from-explore | --show-on-explore]\n' +
  '         [--disable-owner [--reason <text>] | --enable-owner] [--dry-run] [--allow-bucket <bucket>]\n' +
  '       takedown.ts --sub <auth0 user id> [--disable-owner [--reason <text>] | --enable-owner] [--dry-run]\n' +
  '       With no action it only reports: the tour, its owner, and whether the owner is disabled.';

const VALUE_FLAGS = ['--slug', '--tour', '--sub', '--reason', '--allow-bucket'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
const TOUR_FLAGS: Record<string, OperatorTakedownAction> = {
  '--unpublish': 'unpublish',
  '--delete': 'delete',
  // Explore only: the tour stays live by link.
  '--hide-from-explore': 'hide',
  '--show-on-explore': 'unhide',
};
const TOUR_FLAG_OF = Object.fromEntries(Object.entries(TOUR_FLAGS).map(([f, a]) => [a, f]));
/** What the operator sees once an action is done. */
export const TOUR_ACTION_DONE: Record<OperatorTakedownAction, string> = {
  unpublish: 'unpublished',
  delete: 'deleted',
  hide: 'hidden from Explore',
  unhide: 'shown on Explore again',
};
const OWNER_FLAGS: Record<string, OwnerAction> = {
  '--disable-owner': 'disable',
  '--enable-owner': 'enable',
};

// Where admin-api answers for each bucket, unless ADMIN_API_ORIGIN says otherwise.
const DEFAULT_ORIGINS: Record<string, string> = {
  'pano-content-dev': 'https://panote.dev',
  'pano-content': 'https://panote.io',
};

export function parseTakedownArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): TakedownArgs {
  const values: Partial<Record<ValueFlag, string>> = {};
  let tourAction: OperatorTakedownAction | undefined;
  let ownerAction: OwnerAction | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (TOUR_FLAGS[arg]) {
      if (tourAction) {
        throw new Error(
          '--unpublish, --delete, --hide-from-explore and --show-on-explore are exclusive',
        );
      }
      tourAction = TOUR_FLAGS[arg];
    } else if (OWNER_FLAGS[arg]) {
      if (ownerAction) throw new Error('--disable-owner and --enable-owner are exclusive');
      ownerAction = OWNER_FLAGS[arg];
    } else if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      // A pasted id with a stray space would name a tour or account nobody has.
      if (value !== value.trim() || !value)
        throw new Error(`${arg} has leading or trailing whitespace`);
      values[arg as ValueFlag] = value;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  const { '--slug': slug, '--tour': tourId, '--sub': sub, '--reason': reason } = values;
  if (slug !== undefined && tourId !== undefined)
    throw new Error('--slug and --tour are exclusive');
  if (slug === undefined && tourId === undefined && sub === undefined) {
    throw new Error('name a tour (--slug or --tour) or an owner (--sub)');
  }
  if (tourAction && slug === undefined && tourId === undefined) {
    throw new Error(`${TOUR_FLAG_OF[tourAction]} needs --slug or --tour`);
  }
  if (tourId !== undefined && !PANO_PATTERN.test(tourId)) {
    throw new Error(`--tour must match ${PANO_PATTERN}`);
  }
  if (slug !== undefined && !storedSlugKey(slug)) throw new Error('--slug is not a valid slug');
  if (reason !== undefined && ownerAction !== 'disable') {
    throw new Error('--reason goes with --disable-owner');
  }
  if (reason !== undefined && reason.length > 500)
    throw new Error('--reason is over 500 characters');

  const r2 = r2ConfigFromEnv(env, values['--allow-bucket']);
  let api: TakedownArgs['api'];
  if (tourAction) {
    const token = env.OPERATOR_TOKEN;
    if (!token) throw new Error('missing env OPERATOR_TOKEN (admin-api secret of the same name)');
    const fallback = DEFAULT_ORIGINS[r2.bucket];
    const origin = env.ADMIN_API_ORIGIN || fallback;
    if (!origin)
      throw new Error(`no default admin-api origin for ${r2.bucket}; set ADMIN_API_ORIGIN`);
    if (!/^https:\/\/[^/]+$/.test(origin)) {
      throw new Error('ADMIN_API_ORIGIN must be an https origin with no path');
    }
    // An override must not quietly point one env's bucket at another env's admin-api
    // (a dev bucket at panote.io, say): anything but the default is named twice too.
    if (origin !== fallback && values['--allow-bucket'] !== r2.bucket) {
      throw new Error(
        `ADMIN_API_ORIGIN ${origin} isn't the default for ${r2.bucket}; pass --allow-bucket ${r2.bucket} to use it`,
      );
    }
    api = { origin, token };
  }
  return { slug, tourId, sub, tourAction, ownerAction, reason, dryRun, r2, api };
}

export type TakedownStore = Pick<
  R2S3Client,
  'get' | 'head' | 'put' | 'deleteObject' | 'listPrefixes'
>;

const headExists = async (store: TakedownStore, key: string): Promise<boolean> => {
  const head = await store.head(key);
  if (head.ok) return true;
  if (head.status !== 404) throw new Error(`R2 HEAD -> ${head.status}`);
  return false;
};

/** The tourId a share-link slug points at, a live pointer or a redirect alias alike. */
export async function tourIdForSlug(store: TakedownStore, slug: string): Promise<string> {
  const key = storedSlugKey(slug);
  if (!key) throw new Error('not a valid slug');
  const res = await store.get(key);
  if (res.status === 404) throw new Error(`no share link /s/${slug}`);
  if (!res.ok) throw new Error(`R2 GET -> ${res.status}`);
  const parsed = SlugRecordSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success || !PANO_PATTERN.test(parsed.data.tourId)) {
    throw new Error(`share link /s/${slug} is unreadable`);
  }
  return parsed.data.tourId;
}

/** The raw sub behind a base64url owner segment, or null if it isn't one encodeId wrote. */
export function decodeOwner(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const sub = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (ch) => ch.charCodeAt(0)),
    );
    return encodeId(sub) === segment ? sub : null;
  } catch {
    return null;
  }
}

const OWNER_SCAN_CONCURRENCY = 8;

/**
 * The owner of a tour. Tour keys hold the owner and pub/ deliberately doesn't, so
 * this scans every owner under tours/ for one with that tourId: one LIST, then a
 * HEAD per owner. Fine for an occasional takedown; pass --sub to skip it.
 */
export async function findTourOwner(store: TakedownStore, tourId: string): Promise<string> {
  const owners = (await store.listPrefixes('tours/')).map((p) => p.slice('tours/'.length, -1));
  const found: string[] = [];
  for (let i = 0; i < owners.length; i += OWNER_SCAN_CONCURRENCY) {
    await Promise.all(
      owners.slice(i, i + OWNER_SCAN_CONCURRENCY).map(async (owner) => {
        const prefix = `tours/${owner}/${tourId}/`;
        const hits = await Promise.all(
          ['tour.json', 'publish.json'].map((name) => headExists(store, `${prefix}${name}`)),
        );
        if (hits.some(Boolean)) found.push(owner);
      }),
    );
  }
  if (found.length === 0) throw new Error(`no owner has tour ${tourId}`);
  if (found.length > 1) throw new Error(`tour ${tourId} is under ${found.length} owners`);
  const sub = decodeOwner(found[0]!);
  if (sub === null) throw new Error(`tour ${tourId} is under an owner segment that doesn't decode`);
  return sub;
}

/**
 * Refuses unless `sub` holds the tour (tour.json or publish.json under its own
 * prefix), so a mistyped --sub can't disable an account that has nothing to do with it.
 */
export async function assertOwnsTour(
  store: TakedownStore,
  sub: string,
  tourId: string,
): Promise<void> {
  const prefix = `tours/${encodeId(sub)}/${tourId}/`;
  const hits = await Promise.all(
    ['tour.json', 'publish.json'].map((name) => headExists(store, `${prefix}${name}`)),
  );
  if (!hits.some(Boolean)) throw new Error(`--sub ${sub} doesn't own tour ${tourId}; nothing done`);
}

export interface OwnerStatus {
  disabled: AccountDisabledRecord | null;
  deletionRequested: boolean;
}

export async function readOwnerStatus(store: TakedownStore, sub: string): Promise<OwnerStatus> {
  const [res, deletionRequested] = await Promise.all([
    store.get(accountDisabledKey(sub)),
    headExists(store, accountDeletionKey(sub)),
  ]);
  if (res.status === 404) return { disabled: null, deletionRequested };
  if (!res.ok) throw new Error(`R2 GET -> ${res.status}`);
  const parsed = AccountDisabledRecordSchema.safeParse(await res.json().catch(() => null));
  // Unreadable still blocks the owner (admin-api and upload-api only HEAD it).
  return {
    disabled: parsed.success ? parsed.data : { v: 1, disabledAt: 'unknown (unreadable marker)' },
    deletionRequested,
  };
}

/** Writes (or rewrites) the marker: from then on the owner gets 403 on every write and upload. */
export async function disableOwner(
  store: TakedownStore,
  sub: string,
  now: Date,
  reason: string | undefined,
): Promise<AccountDisabledRecord> {
  const record: AccountDisabledRecord = {
    v: 1,
    disabledAt: now.toISOString(),
    ...(reason === undefined ? {} : { reason }),
  };
  await store.put(accountDisabledKey(sub), JSON.stringify(record), {
    contentType: 'application/json',
  });
  return record;
}

/** Removes the marker; deleting one that isn't there is fine. */
export async function enableOwner(store: TakedownStore, sub: string): Promise<void> {
  await store.deleteObject(accountDisabledKey(sub));
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** admin-api's operator route: the owner's own unpublish or tour delete, CDN purge included. */
export async function requestTourTakedown(
  fetchFn: FetchLike,
  api: { origin: string; token: string },
  body: { sub: string; tourId: string; action: OperatorTakedownAction },
): Promise<OperatorTakedownOk> {
  const res = await fetchFn(`${api.origin}${OPERATOR_TAKEDOWN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [OPERATOR_TOKEN_HEADER]: api.token },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error =
      json && typeof json === 'object' && 'error' in json ? JSON.stringify(json.error) : '';
    // A 404 'not found' is also what a wrong token, or no OPERATOR_TOKEN on admin-api, looks like.
    const hint =
      res.status === 404 && error === '"not found"'
        ? ' (check OPERATOR_TOKEN matches the admin-api secret in this env)'
        : '';
    throw new Error(`takedown ${body.action} -> ${res.status} ${error}${hint}`);
  }
  const parsed = OperatorTakedownOkSchema.safeParse(json);
  if (!parsed.success) throw new Error(`takedown ${body.action}: unexpected response`);
  return parsed.data;
}

/** One line for the operator about the owner's state. */
export function describeOwner(sub: string, status: OwnerStatus): string {
  const disabled = status.disabled
    ? `disabled since ${status.disabled.disabledAt}${status.disabled.reason ? ` (${status.disabled.reason})` : ''}`
    : 'not disabled';
  return `owner ${sub}: ${disabled}${status.deletionRequested ? '; account deletion requested' : ''}`;
}
