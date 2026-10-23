// Argument handling and the R2/API steps for the operator's takedown CLI
// (takedown.ts). Pure apart from the store and fetch, so the Worker test pool covers it.
import {
  accountDeletionKey,
  accountDisabledKey,
  AccountDisabledRecordSchema,
  QuarantineCaseRecordSchema,
  configKey,
  encodeId,
  manifestKey,
  OPERATOR_TAKEDOWN_PATH,
  OPERATOR_TOKEN_HEADER,
  OperatorTakedownOkSchema,
  originalKey,
  PANO_PATTERN,
  planPrefix,
  PublishRecordSchema,
  publishKey,
  pubTourKey,
  QUARANTINE_ROOT,
  SlugRecordSchema,
  storedSlugKey,
  tilesPrefix,
  tourKey,
  tourOwnerKey,
  TourOwnerRecordSchema,
  TRASH_ROOT,
  userPanosPrefix,
  userToursPrefix,
  type AccountDisabledRecord,
  type QuarantineCaseRecord,
  type OperatorTakedownAction,
  type OperatorTakedownOk,
} from '@internal/contracts';
import { R2PreconditionFailedError, type R2S3Client } from '@internal/worker-kit/r2-s3';

import {
  operatorApiFromEnv,
  r2ConfigFromEnv,
  requestAccountDeletion,
  type R2Config,
} from './delete-account-lib.ts';
import { fetchWaitingOut429, type Sleep } from './operator-fetch.ts';

export type OwnerAction = 'disable' | 'enable';
/** What happens to the tour(s): the operator route's two actions, or copy-then-delete. */
export type TourAction = OperatorTakedownAction | 'quarantine';

export interface TakedownArgs {
  slug: string | undefined;
  tourId: string | undefined;
  sub: string | undefined;
  tourAction: TourAction | undefined;
  /** --quarantine's case id: the copy goes under quarantine/<caseId>/. */
  caseId: string | undefined;
  /** The tour action applies to every tour the owner has, not just the named one. */
  allTours: boolean;
  /** Marks the account for deletion, as the owner's own Delete account does. */
  closeAccount: boolean;
  /** The operator's word that nothing destroyed here needs keeping as evidence. */
  nothingToPreserve: boolean;
  ownerAction: OwnerAction | undefined;
  reason: string | undefined;
  dryRun: boolean;
  r2: R2Config;
  /** admin-api's operator route; only set (and required) for a tour action. */
  api: { origin: string; token: string } | undefined;
  /** The CDN origin checked after a takedown (cdn.<host>); unset skips the check. */
  cdn: string | undefined;
}

export const USAGE =
  'usage: takedown.ts (--slug <slug> | --tour <tourId> | --sub <auth0 user id>) [--sub <auth0 user id>]\n' +
  '         [--unpublish | --quarantine <caseId> | --delete --nothing-to-preserve |\n' +
  '          --hide-from-explore | --show-on-explore] [--all-tours]\n' +
  '         [--disable-owner [--reason <text>] | --enable-owner] [--close-account]\n' +
  '         [--dry-run] [--allow-bucket <bucket>]\n' +
  '       --quarantine copies the tour (with --all-tours, everything the owner has) to\n' +
  '       quarantine/<caseId>/ and then deletes it; --delete keeps no copy.\n' +
  '       --hide-from-explore keeps the tour live by link but off Explore; --show-on-explore undoes it.\n' +
  '       With no action it only reports: the tour, its owner, and whether the owner is disabled.';

const VALUE_FLAGS = [
  '--slug',
  '--tour',
  '--sub',
  '--reason',
  '--allow-bucket',
  '--quarantine',
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
const TOUR_FLAGS: Record<string, OperatorTakedownAction> = {
  '--unpublish': 'unpublish',
  '--delete': 'delete',
  // Explore only: the tour stays live by link.
  '--hide-from-explore': 'hide',
  '--show-on-explore': 'unhide',
};
const TOUR_FLAG_OF: Record<TourAction, string> = {
  ...(Object.fromEntries(Object.entries(TOUR_FLAGS).map(([f, a]) => [a, f])) as Record<
    OperatorTakedownAction,
    string
  >),
  quarantine: '--quarantine',
};
const EXCLUSIVE_TOUR_FLAGS =
  '--unpublish, --quarantine, --delete, --hide-from-explore and --show-on-explore are exclusive';
/** What the operator sees once the route has done an action. */
export const TOUR_ACTION_DONE: Record<OperatorTakedownAction, string> = {
  unpublish: 'unpublished',
  delete: 'deleted',
  hide: 'hidden from Explore',
  unhide: 'shown on Explore again',
};
const BOOLEAN_FLAGS = ['--dry-run', '--all-tours', '--close-account', '--nothing-to-preserve'];
// A case id names a folder: short, lowercase, no slashes. A date and a ticket, say.
const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OWNER_FLAGS: Record<string, OwnerAction> = {
  '--disable-owner': 'disable',
  '--enable-owner': 'enable',
};

export function parseTakedownArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): TakedownArgs {
  const values: Partial<Record<ValueFlag, string>> = {};
  const flags = new Set<string>();
  let tourAction: TourAction | undefined;
  let ownerAction: OwnerAction | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (BOOLEAN_FLAGS.includes(arg)) {
      flags.add(arg);
    } else if (TOUR_FLAGS[arg]) {
      if (tourAction) throw new Error(EXCLUSIVE_TOUR_FLAGS);
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
      if (arg === '--quarantine') {
        if (tourAction) throw new Error(EXCLUSIVE_TOUR_FLAGS);
        tourAction = 'quarantine';
      }
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  const { '--slug': slug, '--tour': tourId, '--sub': sub, '--reason': reason } = values;
  const caseId = values['--quarantine'];
  const dryRun = flags.has('--dry-run');
  const allTours = flags.has('--all-tours');
  const closeAccount = flags.has('--close-account');
  const nothingToPreserve = flags.has('--nothing-to-preserve');
  if (slug !== undefined && tourId !== undefined)
    throw new Error('--slug and --tour are exclusive');
  if (slug === undefined && tourId === undefined && sub === undefined) {
    throw new Error('name a tour (--slug or --tour) or an owner (--sub)');
  }
  if (tourAction && !allTours && slug === undefined && tourId === undefined) {
    throw new Error(`${TOUR_FLAG_OF[tourAction]} needs --slug or --tour, or --all-tours`);
  }
  if (allTours && !tourAction) {
    throw new Error(
      '--all-tours goes with a tour action (--unpublish, --quarantine, --delete, ...)',
    );
  }
  if (caseId !== undefined && !CASE_ID_PATTERN.test(caseId)) {
    throw new Error('--quarantine needs a case id: lowercase letters, digits and -');
  }
  // Deleting destroys what may be evidence (illegal images, a disputed claim): the
  // operator either keeps a copy first or says in so many words that none is needed.
  if (tourAction === 'delete' && !nothingToPreserve) {
    throw new Error(
      '--delete keeps no copy: use --quarantine <caseId> to keep one, or add --nothing-to-preserve',
    );
  }
  if (closeAccount && !nothingToPreserve && !(tourAction === 'quarantine' && allTours)) {
    throw new Error(
      '--close-account deletes everything the owner has: use it with --all-tours --quarantine <caseId>, or add --nothing-to-preserve',
    );
  }
  if (nothingToPreserve && tourAction !== 'delete' && !closeAccount) {
    throw new Error('--nothing-to-preserve goes with --delete or --close-account');
  }
  if (closeAccount && ownerAction === 'enable') {
    throw new Error('--close-account and --enable-owner are exclusive');
  }
  // The owner is blocked first, so nothing they write lands between the copy and the delete.
  if ((tourAction === 'quarantine' || closeAccount) && ownerAction !== 'disable') {
    throw new Error(
      `${tourAction === 'quarantine' ? '--quarantine' : '--close-account'} needs --disable-owner`,
    );
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
  const api = tourAction ? operatorApiFromEnv(env, r2.bucket, values['--allow-bucket']) : undefined;
  const cdn = tourAction ? cdnOriginFromEnv(env, r2.bucket) : undefined;
  return {
    slug,
    tourId,
    sub,
    tourAction,
    caseId,
    allTours,
    closeAccount,
    nothingToPreserve,
    ownerAction,
    reason,
    dryRun,
    r2,
    api,
    cdn,
  };
}

const DEFAULT_CDN_ORIGINS: Record<string, string> = {
  'pano-content-dev': 'https://cdn.panote.dev',
  'pano-content': 'https://cdn.panote.io',
};

/**
 * Where the bucket's public keys are served, for the check after a takedown: the
 * bucket's own CDN host, or CDN_ORIGIN. Undefined (no check) for any other bucket.
 */
export function cdnOriginFromEnv(
  env: Record<string, string | undefined>,
  bucket: string,
): string | undefined {
  const origin = env.CDN_ORIGIN || DEFAULT_CDN_ORIGINS[bucket];
  if (origin !== undefined && !/^https:\/\/[^/]+$/.test(origin)) {
    throw new Error('CDN_ORIGIN must be an https origin with no path');
  }
  return origin;
}

export type TakedownStore = Pick<
  R2S3Client,
  'get' | 'head' | 'put' | 'deleteObject' | 'listPrefixes' | 'listObjects'
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

const ownsTour = async (store: TakedownStore, sub: string, tourId: string): Promise<boolean> => {
  const prefix = `tours/${encodeId(sub)}/${tourId}/`;
  const hits = await Promise.all(
    ['tour.json', 'publish.json'].map((name) => headExists(store, `${prefix}${name}`)),
  );
  return hits.some(Boolean);
};

/**
 * The owner admin-api recorded for the tour (tourOwnerKey) when it was created or
 * published, once that owner is seen to still hold it. Null when there's no usable
 * pointer: an older tour, or one that is gone.
 */
export async function ownerFromIndex(store: TakedownStore, tourId: string): Promise<string | null> {
  const res = await store.get(tourOwnerKey(tourId));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GET -> ${res.status}`);
  const parsed = TourOwnerRecordSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return null;
  return (await ownsTour(store, parsed.data.sub, tourId)) ? parsed.data.sub : null;
}

/**
 * The owner of a tour: from admin-api's pointer when there is one. Otherwise (a tour
 * from before the pointer) it scans every owner under tours/ for one with that
 * tourId, since tour keys hold the owner and pub/ deliberately doesn't: one LIST,
 * then a HEAD per owner. Pass --sub to skip both.
 */
export async function findTourOwner(store: TakedownStore, tourId: string): Promise<string> {
  const indexed = await ownerFromIndex(store, tourId);
  if (indexed !== null) return indexed;
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
  if (!(await ownsTour(store, sub, tourId))) {
    throw new Error(`--sub ${sub} doesn't own tour ${tourId}; nothing done`);
  }
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

/** Every tour the owner has, by its directory under tours/<owner>/. */
export async function listOwnerTours(store: TakedownStore, sub: string): Promise<string[]> {
  const prefix = userToursPrefix(sub);
  return (await store.listPrefixes(prefix))
    .map((p) => p.slice(prefix.length, -1))
    .filter((id) => PANO_PATTERN.test(id));
}

/** Where the quarantine copy of `key` lives for a case. */
export const quarantineKey = (caseId: string, key: string): string =>
  `${QUARANTINE_ROOT}${caseId}/${key}`;
export const caseRecordKey = (caseId: string): string => `${QUARANTINE_ROOT}${caseId}/case.json`;

const readJson = async (store: TakedownStore, key: string): Promise<unknown> => {
  const res = await store.get(key);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GET ${key} -> ${res.status}`);
  return res.json().catch(() => null);
};

// The scenes' panoIds in a tour.json or a public bundle; both list { panoId } scenes.
const scenePanoIds = (doc: unknown): string[] => {
  const scenes = (doc as { scenes?: unknown } | null)?.scenes;
  if (!Array.isArray(scenes)) return [];
  return scenes
    .map((s) => (s as { panoId?: unknown } | null)?.panoId)
    .filter((id): id is string => typeof id === 'string' && PANO_PATTERN.test(id));
};

const panoKeys = (sub: string, panoIds: Iterable<string>): string[] =>
  [...panoIds].flatMap((p) => [originalKey(sub, p), configKey(sub, p)]);

/**
 * The trash copies (trash/<date>/panos/<owner>/<panoId>/original) of the owner's originals,
 * of `panoIds` only when given: an original the owner deleted before the takedown is only
 * there, and the takedown's delete removes it from there too. One listing per day held.
 */
async function trashedOriginalKeys(
  store: TakedownStore,
  sub: string,
  panoIds?: readonly string[],
): Promise<string[]> {
  const wanted = panoIds && new Set(panoIds.map((p) => originalKey(sub, p)));
  const keys: string[] = [];
  for (const day of await store.listPrefixes(TRASH_ROOT)) {
    for (const o of await store.listObjects(`${day}${userPanosPrefix(sub)}`)) {
      const key = o.key.slice(day.length);
      if (wanted ? wanted.has(key) : key.endsWith('/original')) keys.push(o.key);
    }
  }
  return keys;
}

export interface TourContent {
  /** Every key worth keeping, whether or not it exists. */
  keys: string[];
  panoIds: string[];
}

/**
 * What a tour is made of: its tour.json, publish record, public bundle, share links,
 * floor-plan images, and each scene's original and config (scenes from the tour and from the bundle, which
 * may still show one since removed from the tour), with any trash copy of those originals.
 */
export async function tourContent(
  store: TakedownStore,
  sub: string,
  tourId: string,
): Promise<TourContent> {
  const [tour, bundle, record, plans] = await Promise.all([
    readJson(store, tourKey(sub, tourId)),
    readJson(store, pubTourKey(tourId)),
    readJson(store, publishKey(sub, tourId)),
    // Every plan image under the tour's prefix, not just the ones named: the tour's
    // delete takes the whole prefix (replaced and never-saved uploads too).
    store.listObjects(planPrefix(tourId)),
  ]);
  const panoIds = [...new Set([...scenePanoIds(tour), ...scenePanoIds(bundle)])];
  const published = PublishRecordSchema.safeParse(record);
  const slugs = published.success
    ? [published.data.slug, ...(published.data.aliases ?? [])].map(storedSlugKey)
    : [];
  const keys = [
    tourKey(sub, tourId),
    publishKey(sub, tourId),
    pubTourKey(tourId),
    ...slugs.filter((k): k is string => k !== null),
    ...plans.map((o) => o.key),
    ...panoKeys(sub, panoIds),
    ...(await trashedOriginalKeys(store, sub, panoIds)),
  ];
  return { keys: [...new Set(keys)], panoIds };
}

/** Every pano the owner has, in a tour or not: originals and configs, and every trashed original. */
export async function ownerPanoContent(store: TakedownStore, sub: string): Promise<TourContent> {
  const prefix = userPanosPrefix(sub);
  const panoIds = (await store.listPrefixes(prefix))
    .map((p) => p.slice(prefix.length, -1))
    .filter((id) => PANO_PATTERN.test(id));
  return {
    keys: [...panoKeys(sub, panoIds), ...(await trashedOriginalKeys(store, sub))],
    panoIds,
  };
}

// A single-part PUT's ETag is the body's MD5 on S3 and R2; a multipart one ("…-N") isn't.
const md5Etag = (etag: string | null): string | null =>
  etag && /^"?[0-9a-f]{32}"?$/i.test(etag) ? etag.replace(/"/g, '').toLowerCase() : null;

/**
 * Throws unless the copy at `dest` has `key`'s size, and its ETag where both are content
 * hashes. `problem` says what's wrong with a copy that fails.
 */
async function verifyCopy(
  store: TakedownStore,
  key: string,
  dest: string,
  source: { bytes: number; etag: string | null },
  problem: (what: string) => string,
): Promise<void> {
  const [head, listed] = await Promise.all([store.head(dest), store.listObjects(dest)]);
  const size = listed.find((o) => o.key === dest)?.size;
  if (!head.ok || size === undefined) throw new Error(problem('is missing'));
  if (size !== source.bytes) throw new Error(problem(`is ${size} bytes, not ${source.bytes}`));
  const [want, got] = [md5Etag(source.etag), md5Etag(head.etag)];
  if (want && got && want !== got) throw new Error(problem(`differs from ${key}`));
}

/**
 * Copies one object to quarantine/<caseId>/<key>, byte for byte with its content type.
 * Create-only: a rerun keeps an existing copy, but only once it matches the source. False
 * when there's nothing at `key`. Throws unless the copy, new or existing, has the same
 * size, and the same ETag where both are content hashes, so nothing is removed on the
 * strength of a copy that failed or came out short.
 */
export async function copyToQuarantine(
  store: TakedownStore,
  caseId: string,
  key: string,
): Promise<boolean> {
  const res = await store.get(key);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`R2 GET ${key} -> ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  const source = { bytes: body.byteLength, etag: res.headers.get('etag') };
  const dest = quarantineKey(caseId, key);
  try {
    await store.put(dest, body, {
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      ifNoneMatch: '*',
    });
  } catch (e) {
    if (!(e instanceof R2PreconditionFailedError)) throw e;
    // A copy from an earlier run: trusted only if it matches what's there now.
    await verifyCopy(
      store,
      key,
      dest,
      source,
      (what) => `the existing quarantine copy of ${key} ${what}; keep it and pick a new case id`,
    );
    return true;
  }
  await verifyCopy(store, key, dest, source, (what) => `quarantine copy of ${key} ${what}`);
  return true;
}

/**
 * Writes (or adds to) quarantine/<caseId>/case.json, the operator's record of what the
 * case holds and whose it was. One case is one owner: adding another owner's content
 * to it is refused, as is an unreadable record. The write is conditional on the record
 * read, so two runs on one case can't drop each other's keys.
 */
export async function writeCaseRecord(
  store: TakedownStore,
  caseId: string,
  add: { sub: string; tourIds: string[]; keys: string[]; reason: string | undefined },
  now: Date,
): Promise<QuarantineCaseRecord> {
  const key = caseRecordKey(caseId);
  const res = await store.get(key);
  let existing: QuarantineCaseRecord | null = null;
  let etag: string | null = null;
  if (res.ok) {
    const parsed = QuarantineCaseRecordSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error(`${key} is unreadable; fix it or pick a new case id`);
    existing = parsed.data;
    etag = res.headers.get('etag');
    if (!etag) throw new Error(`R2 GET ${key}: no ETag`);
  } else if (res.status !== 404) {
    throw new Error(`R2 GET ${key} -> ${res.status}`);
  }
  if (existing && existing.sub !== add.sub) {
    throw new Error(`case ${caseId} already holds another owner's content; pick a new case id`);
  }
  const reason = add.reason ?? existing?.reason;
  const record: QuarantineCaseRecord = {
    v: 1,
    caseId,
    sub: add.sub,
    tourIds: [...new Set([...(existing?.tourIds ?? []), ...add.tourIds])],
    keys: [...new Set([...(existing?.keys ?? []), ...add.keys])],
    firstAt: existing?.firstAt ?? now.toISOString(),
    lastAt: now.toISOString(),
    ...(reason === undefined ? {} : { reason }),
  };
  try {
    await store.put(key, JSON.stringify(record), {
      contentType: 'application/json',
      ...(etag ? { ifMatch: etag } : { ifNoneMatch: '*' as const }),
    });
  } catch (e) {
    if (e instanceof R2PreconditionFailedError) {
      throw new Error(`${key} changed while this run was writing it; rerun the same command`, {
        cause: e,
      });
    }
    throw e;
  }
  return record;
}

/** The panos whose public tiles are still there (another of the owner's tours uses them). */
export async function panosWithTiles(
  store: TakedownStore,
  panoIds: readonly string[],
): Promise<string[]> {
  const left: string[] = [];
  for (const panoId of panoIds) {
    if (await headExists(store, manifestKey(panoId))) left.push(panoId);
  }
  return left;
}

export const TAKEDOWN_REQUEST_TIMEOUT_MS = 120_000;

/** admin-api's operator route: the owner's own unpublish or tour delete, CDN purge included. */
export async function requestTourTakedown(
  fetchFn: FetchLike,
  api: { origin: string; token: string },
  body: { sub: string; tourId: string; action: OperatorTakedownAction },
  sleep?: Sleep,
): Promise<OperatorTakedownOk> {
  const res = await fetchWaitingOut429(
    // Each attempt gets its own timeout, far past the route's own bounds (its purge stops
    // after 20 seconds), so a hung connection fails the run instead of holding it.
    (input, init) =>
      fetchFn(input, { ...init, signal: AbortSignal.timeout(TAKEDOWN_REQUEST_TIMEOUT_MS) }),
    `${api.origin}${OPERATOR_TAKEDOWN_PATH}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [OPERATOR_TOKEN_HEADER]: api.token },
      body: JSON.stringify(body),
    },
    sleep,
  );
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

/** What admin-api says its CDN purge did, for the operator. */
export function describePurge(done: OperatorTakedownOk): string {
  const p = done.purge;
  // An admin-api from before it reported the outcome.
  if (!p) return `${done.purged} CDN purge target(s) planned (outcome not reported)`;
  switch (p.status) {
    case 'none':
      return 'nothing to purge from the CDN';
    case 'purged':
      return `CDN purge done (${p.purged} URL(s))`;
    case 'pending':
      return `CDN purge: ${p.purged} URL(s) done, ${p.pending} queued (admin-api retries them every 15 minutes)`;
    case 'failed':
      return `CDN purge FAILED for ${p.failed} URL(s) (${p.purged} done, ${p.pending} queued); see admin-api's logs`;
    case 'skipped':
      return 'CDN purge SKIPPED: admin-api has no CF_PURGE_TOKEN or CDN_ZONE_ID; edge copies stay until they expire';
  }
}

/** A public key to fetch from the CDN after the takedown; `panoId` for a pano's tiles. */
export interface CdnSample {
  key: string;
  panoId?: string;
}

// Panos sampled for the CDN check: enough to show the purge worked, few enough to be quick.
export const CDN_CHECK_MAX_PANOS = 20;

/**
 * Before a takedown: public keys that exist now and should be gone from the CDN after it.
 * Each tour's bundle, and with `withTiles` (a delete) each pano's manifest and one tile.
 */
export async function sampleCdnKeys(
  store: TakedownStore,
  tourIds: readonly string[],
  panoIds: readonly string[],
  withTiles: boolean,
): Promise<CdnSample[]> {
  const out: CdnSample[] = [];
  for (const tourId of tourIds) {
    if (await headExists(store, pubTourKey(tourId))) out.push({ key: pubTourKey(tourId) });
  }
  if (!withTiles) return out;
  for (const panoId of panoIds.slice(0, CDN_CHECK_MAX_PANOS)) {
    const keys = (await store.listObjects(tilesPrefix(panoId))).map((o) => o.key);
    const manifest = manifestKey(panoId);
    const tile = keys.find((k) => k !== manifest);
    if (keys.includes(manifest)) out.push({ key: manifest, panoId });
    if (tile !== undefined) out.push({ key: tile, panoId });
  }
  return out;
}

/**
 * After a takedown: fetches each sample from the CDN (skipping panos whose tiles were
 * kept) and returns the URLs it still serves. Only the edge this runs near is seen.
 */
export async function checkCdn(
  fetchFn: FetchLike,
  cdn: string,
  samples: readonly CdnSample[],
  keptPanos: ReadonlySet<string>,
): Promise<{ checked: number; served: string[]; unreachable: string[] }> {
  const out = { checked: 0, served: [] as string[], unreachable: [] as string[] };
  for (const { key, panoId } of samples) {
    if (panoId !== undefined && keptPanos.has(panoId)) continue;
    const url = `${cdn}/${key}`;
    out.checked++;
    try {
      const res = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(15_000) });
      await res.body?.cancel();
      if (res.ok) out.served.push(url);
    } catch {
      out.unreachable.push(url);
    }
  }
  return out;
}

export interface TakedownResult {
  /** URLs the CDN still served after the takedown (empty when there was no check). */
  cdnStillServed: string[];
}

/** One line for the operator about the owner's state. */
export function describeOwner(sub: string, status: OwnerStatus): string {
  const disabled = status.disabled
    ? `disabled since ${status.disabled.disabledAt}${status.disabled.reason ? ` (${status.disabled.reason})` : ''}`
    : 'not disabled';
  return `owner ${sub}: ${disabled}${status.deletionRequested ? '; account deletion requested' : ''}`;
}

export interface TakedownDeps {
  store: TakedownStore;
  fetch: FetchLike;
  log: (line: string) => void;
  now: () => Date;
  /** How a 429 is waited out (operator-fetch.ts); tests pass one that doesn't wait. */
  sleep?: Sleep;
}

/** Printed after --disable-owner: how to ban the owner's email too (docs/deploy.md, "Email ban list"). */
export const BAN_EMAIL_HINT = (sub: string): string =>
  `to stop a new sign-up with the same email: in Auth0, User Management → Users, search for ${sub}, copy its email, run \`node packages/auth0-actions/scripts/ban-email.cjs <email>\` and append the printed hash to the "Block banned emails" Action's BANNED_EMAIL_SHA256 secret (docs/deploy.md, "Email ban list")`;

/**
 * The whole CLI run (takedown.ts only parses and wires it): find the tour(s) and owner,
 * then, unless it's a dry run, block or unblock the owner, quarantine, take tours down
 * through admin-api, and close the account, in that order. A quarantine makes and checks
 * every copy, and writes the case record, before any delete is requested.
 */
export async function runTakedown(args: TakedownArgs, deps: TakedownDeps): Promise<TakedownResult> {
  const result: TakedownResult = { cdnStillServed: [] };
  const { store, log } = deps;
  // Read-only from here to the dry-run stop: find the tour(s) and the owner.
  const tourId = args.slug !== undefined ? await tourIdForSlug(store, args.slug) : args.tourId;
  const sub = args.sub ?? (tourId !== undefined ? await findTourOwner(store, tourId) : undefined);
  if (sub === undefined) throw new Error('no owner to act on');
  // A --sub given with a tour must be that tour's owner, before anything is written.
  if (args.sub !== undefined && tourId !== undefined) await assertOwnsTour(store, sub, tourId);
  if (tourId !== undefined) log(`tour ${tourId}`);
  log(describeOwner(sub, await readOwnerStatus(store, sub)));
  const tourIds = args.allTours ? await listOwnerTours(store, sub) : tourId ? [tourId] : [];
  if (args.allTours) log(`owner has ${tourIds.length} tour(s): ${tourIds.join(', ')}`);

  // A quarantine is copy-then-delete; every other action is the route's own.
  const routeAction: OperatorTakedownAction | undefined =
    args.tourAction === 'quarantine' ? 'delete' : args.tourAction;
  const planned = [
    args.ownerAction && `${args.ownerAction} owner`,
    args.tourAction === 'quarantine' &&
      `copy ${args.allTours ? 'everything the owner has' : 'the tour'} to ${quarantineKey(args.caseId!, '')}`,
    args.tourAction &&
      tourIds.length > 0 &&
      `${routeAction} ${tourIds.length} tour(s) via ${args.api?.origin}`,
    args.closeAccount && 'mark the account for deletion',
  ].filter(Boolean);
  if (planned.length === 0) return result;
  if (args.dryRun) {
    log(`DRY RUN: would ${planned.join(', then ')} in ${args.r2.bucket}`);
    return result;
  }

  // Owner first: a disabled owner can't republish, or add to what's being copied.
  if (args.ownerAction === 'disable') {
    await disableOwner(store, sub, deps.now(), args.reason);
    log('owner disabled: uploads and admin writes now answer 403');
    // The marker blocks this Auth0 user only. The script can't see the email (it has no
    // Auth0 access), so it names the step that stops a fresh sign-up with the same address.
    log(BAN_EMAIL_HINT(sub));
  } else if (args.ownerAction === 'enable') {
    await enableOwner(store, sub);
    log('owner enabled again');
  }

  const panoIds = new Set<string>();
  if (args.tourAction === 'quarantine') {
    const caseId = args.caseId!;
    const keys = new Set<string>();
    const contents = await Promise.all(tourIds.map((id) => tourContent(store, sub, id)));
    if (args.allTours) contents.push(await ownerPanoContent(store, sub));
    for (const content of contents) {
      content.keys.forEach((k) => keys.add(k));
      content.panoIds.forEach((p) => panoIds.add(p));
    }
    const copied: string[] = [];
    for (const key of keys) if (await copyToQuarantine(store, caseId, key)) copied.push(key);
    const reason = args.reason;
    await writeCaseRecord(store, caseId, { sub, tourIds, keys: copied, reason }, deps.now());
    log(`${copied.length} object(s) copied to ${quarantineKey(caseId, '')} (case.json lists them)`);
  }

  // What should be gone from the CDN once the tours are down, read before they are.
  const takesDown = routeAction === 'delete' || routeAction === 'unpublish';
  let samples: CdnSample[] = [];
  if (takesDown && args.cdn !== undefined) {
    if (routeAction === 'delete' && args.tourAction !== 'quarantine') {
      for (const id of tourIds)
        (await tourContent(store, sub, id)).panoIds.forEach((p) => panoIds.add(p));
    }
    samples = await sampleCdnKeys(store, tourIds, [...panoIds], routeAction === 'delete');
  }

  if (args.tourAction && args.api) {
    // One at a time: each delete checks which panos the owner's other tours still use.
    for (const id of tourIds) {
      const done = await requestTourTakedown(
        deps.fetch,
        args.api,
        { sub, tourId: id, action: routeAction! },
        deps.sleep,
      );
      log(
        `tour ${id} ${TOUR_ACTION_DONE[done.action]}` +
          (done.action === 'hide' || done.action === 'unhide' ? '' : `; ${describePurge(done)}`),
      );
    }
    if (routeAction === 'unpublish') {
      log('panos and their tiles are kept (reachable by direct URL); --quarantine removes them');
    }
  }

  if (args.closeAccount) {
    const { created } = await requestAccountDeletion(store, sub, deps.now());
    log(
      created
        ? 'account marked for deletion: the next daily sweep deletes what is left, with its tiles'
        : 'account was already marked for deletion',
    );
  }

  // Tiles live under the panoId, not the owner: say which ones are still public.
  const tiled = await panosWithTiles(store, [...panoIds]);
  if (tiled.length > 0) {
    log(
      `tiles still public for ${tiled.length} pano(s): ${tiled.join(', ')}` +
        (args.closeAccount
          ? ' (the account-deletion sweep removes them)'
          : " (another of the owner's tours uses them; --all-tours takes those down too)"),
    );
  }

  // The purge's proof: what was taken down no longer comes back from the CDN.
  if (args.cdn !== undefined && samples.length > 0) {
    const check = await checkCdn(deps.fetch, args.cdn, samples, new Set(tiled));
    result.cdnStillServed = check.served;
    if (check.served.length > 0) {
      log(
        `CDN STILL SERVES ${check.served.length} of ${check.checked} URL(s) checked: ${check.served.join(', ')}. ` +
          'If the purge was queued, admin-api retries it every 15 minutes; check again after that, ' +
          'and if it persists, purge them by URL in the Cloudflare dashboard (Caching > Configuration > Custom Purge).',
      );
    } else if (check.unreachable.length === check.checked) {
      log(
        `CDN check: ${args.cdn} unreachable; check the URLs by hand: ${check.unreachable.join(', ')}`,
      );
    } else {
      log(`CDN check: none of ${check.checked} URL(s) checked is served any more from ${args.cdn}`);
    }
  }
  return result;
}
