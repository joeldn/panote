// Argument handling, planning and the API calls for the operator's restore CLI
// (restore-backup.ts). Pure apart from the store and fetch, so the Worker test pool covers it.
// Reads go over the R2 S3 API; writes go through admin-api's operator restore route,
// because only the native binding carries an object's custom metadata back exactly.
import {
  ACCOUNTS_ROOT,
  BACKUP_DATE_PATTERN,
  BACKUP_PROGRESS_KEY,
  BACKUP_ROOT,
  BACKUP_SOURCES,
  backupCompleteKey,
  BackupCompleteRecordSchema,
  backupKey,
  BackupProgressSchema,
  backupSetPrefix,
  encodeId,
  EXPLORE_INDEX_ROOT,
  exploreCursorOf,
  exploreHiddenKey,
  exploreTourKey,
  isBackedUpKey,
  isRestorableKey,
  OPERATOR_RESTORE_MAX_KEYS,
  OPERATOR_RESTORE_PATH,
  OPERATOR_TOKEN_HEADER,
  OperatorRestoreOkSchema,
  PANO_PATTERN,
  PublishRecordSchema,
  pubTourKey,
  SlugRecordSchema,
  storedSlugKey,
  tourOwnerKey,
  type BackupCompleteRecord,
  type OperatorRestoreOk,
} from '@internal/contracts';
import type { R2S3Client } from '@internal/worker-kit/r2-s3';

import { operatorApiFromEnv, r2ConfigFromEnv, type R2Config } from './delete-account-lib.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type RestoreScope =
  | { kind: 'tour'; tourId: string; sub: string | undefined }
  | { kind: 'owner'; sub: string }
  | { kind: 'all' };

export type RestoreArgs =
  | { mode: 'list'; r2: R2Config }
  | {
      mode: 'restore';
      date: string;
      scope: RestoreScope;
      overwrite: boolean;
      apply: boolean;
      r2: R2Config;
      /** admin-api's operator route; only set (and required) with --apply. */
      api: { origin: string; token: string } | undefined;
    };

export const USAGE =
  'usage: restore-backup.ts --list [--allow-bucket <bucket>]\n' +
  '       restore-backup.ts --date <YYYY-MM-DD> (--tour <tourId> [--sub <auth0 user id>] |\n' +
  '                         --sub <auth0 user id> | --all) [--overwrite] [--apply] [--allow-bucket <bucket>]\n' +
  '       Lists what it would restore unless --apply. Only keys missing now are restored;\n' +
  '       --overwrite also replaces ones that exist with the backed-up copy.';

const VALUE_FLAGS = ['--date', '--tour', '--sub', '--allow-bucket'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
const BOOLEAN_FLAGS = ['--list', '--all', '--overwrite', '--apply'];

export function parseRestoreArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): RestoreArgs {
  const values: Partial<Record<ValueFlag, string>> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (BOOLEAN_FLAGS.includes(arg)) {
      flags.add(arg);
    } else if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      // A pasted id with a stray space would name a tour or account nobody has.
      if (value !== value.trim() || !value) {
        throw new Error(`${arg} has leading or trailing whitespace`);
      }
      values[arg as ValueFlag] = value;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  const r2 = r2ConfigFromEnv(env, values['--allow-bucket']);
  const { '--date': date, '--tour': tourId, '--sub': sub } = values;
  if (flags.has('--list')) {
    const extra = ['--all', '--overwrite', '--apply'].some((f) => flags.has(f));
    if (extra || date !== undefined || tourId !== undefined || sub !== undefined) {
      throw new Error('--list takes no other arguments but --allow-bucket');
    }
    return { mode: 'list', r2 };
  }
  if (date === undefined) throw new Error('--date is required (see --list for the sets there are)');
  if (!BACKUP_DATE_PATTERN.test(date)) throw new Error('--date must be YYYY-MM-DD');
  const all = flags.has('--all');
  let scope: RestoreScope;
  if (tourId !== undefined) {
    if (all) throw new Error('--tour and --all are exclusive');
    if (!PANO_PATTERN.test(tourId)) throw new Error(`--tour must match ${PANO_PATTERN}`);
    scope = { kind: 'tour', tourId, sub };
  } else if (sub !== undefined) {
    if (all) throw new Error('--sub and --all are exclusive');
    scope = { kind: 'owner', sub };
  } else if (all) {
    scope = { kind: 'all' };
  } else {
    throw new Error('name what to restore: --tour, --sub or --all');
  }
  const apply = flags.has('--apply');
  return {
    mode: 'restore',
    date,
    scope,
    overwrite: flags.has('--overwrite'),
    apply,
    r2,
    api: apply ? operatorApiFromEnv(env, r2.bucket, values['--allow-bucket']) : undefined,
  };
}

export type RestoreStore = Pick<R2S3Client, 'get' | 'head' | 'listObjects' | 'listPrefixes'>;

const readJson = async (store: RestoreStore, key: string): Promise<unknown> => {
  const res = await store.get(key);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GET ${key} -> ${res.status}`);
  return res.json().catch(() => null);
};

export interface BackupSet {
  date: string;
  /** The set's complete.json, or null while (or if) it is partial. */
  complete: BackupCompleteRecord | null;
  /** The backup run is still writing this set. */
  inProgress: boolean;
}

/** Every dated set in the bucket, oldest first. */
export async function listBackupSets(store: RestoreStore): Promise<BackupSet[]> {
  const dates = (await store.listPrefixes(BACKUP_ROOT))
    .map((p) => p.slice(BACKUP_ROOT.length, -1))
    .filter((d) => BACKUP_DATE_PATTERN.test(d))
    .sort();
  const progress = BackupProgressSchema.safeParse(await readJson(store, BACKUP_PROGRESS_KEY));
  return Promise.all(
    dates.map(async (date) => {
      const parsed = BackupCompleteRecordSchema.safeParse(
        await readJson(store, backupCompleteKey(date)),
      );
      return {
        date,
        complete: parsed.success ? parsed.data : null,
        inProgress: progress.success && progress.data.date === date,
      };
    }),
  );
}

export function describeSet(set: BackupSet): string {
  if (set.complete) {
    const c = set.complete;
    const lost = c.failed + c.skipped;
    return `${set.date}: complete, ${c.objects} object(s), ${c.bytes} bytes${lost ? `, ${lost} object(s) NOT copied (failed or too large)` : ''}`;
  }
  return `${set.date}: ${set.inProgress ? 'still being written' : 'INCOMPLETE (the run never finished it)'}`;
}

/** The keys in a day's set, as original keys. */
async function setKeys(store: RestoreStore, date: string): Promise<Set<string>> {
  const prefix = backupSetPrefix(date);
  return new Set(
    (await store.listObjects(prefix)).map((o) => o.key.slice(prefix.length)).filter(isBackedUpKey),
  );
}

/** Owner segments with an account deletion marker now. */
async function deletedOwners(store: RestoreStore): Promise<Set<string>> {
  const re = /^accounts\/([^/]+)\/deletion\.json$/;
  return new Set(
    (await store.listObjects(ACCOUNTS_ROOT))
      .map((o) => re.exec(o.key)?.[1])
      .filter((s): s is string => s !== undefined),
  );
}

// The scenes' panoIds in a tour.json or a public bundle; both list { panoId } scenes.
const scenePanoIds = (doc: unknown): string[] => {
  const scenes = (doc as { scenes?: unknown } | null)?.scenes;
  if (!Array.isArray(scenes)) return [];
  return scenes
    .map((s) => (s as { panoId?: unknown } | null)?.panoId)
    .filter((id): id is string => typeof id === 'string' && PANO_PATTERN.test(id));
};

/**
 * The tour's keys outside its owner's prefix, as the set has them: public bundle, owner
 * index, Explore pointer, entry and hidden marker, and each share link (live slug and
 * aliases from its backed-up publish record) that the backup shows pointing at it.
 */
async function tourPublicKeys(
  store: RestoreStore,
  date: string,
  inSet: Set<string>,
  owner: string | null,
  tourId: string,
): Promise<string[]> {
  const keys = [
    pubTourKey(tourId),
    tourOwnerKey(tourId),
    exploreTourKey(tourId),
    exploreHiddenKey(tourId),
  ];
  for (const k of inSet) {
    if (k.startsWith(EXPLORE_INDEX_ROOT) && exploreCursorOf(k)?.endsWith(`-${tourId}`))
      keys.push(k);
  }
  if (owner !== null) {
    const record = PublishRecordSchema.safeParse(
      await readJson(store, backupKey(date, `tours/${owner}/${tourId}/publish.json`)),
    );
    if (record.success) {
      for (const slug of [record.data.slug, ...(record.data.aliases ?? [])]) {
        const key = storedSlugKey(slug);
        if (!key || !inSet.has(key)) continue;
        const slugRecord = SlugRecordSchema.safeParse(await readJson(store, backupKey(date, key)));
        if (slugRecord.success && slugRecord.data.tourId === tourId) keys.push(key);
      }
    }
  }
  return keys.filter((k) => inSet.has(k));
}

/** The owner segment(s) holding a tour in the set. */
const tourOwners = (inSet: Set<string>, tourId: string): string[] => {
  const owners = new Set<string>();
  for (const k of inSet) {
    const m = /^tours\/([^/]+)\/([^/]+)\//.exec(k);
    if (m && m[2] === tourId) owners.add(m[1]!);
  }
  return [...owners];
};

const ownerTourIds = (inSet: Set<string>, owner: string): string[] => {
  const ids = new Set<string>();
  for (const k of inSet) {
    const m = /^tours\/([^/]+)\/([^/]+)\//.exec(k);
    if (m && m[1] === owner) ids.add(m[2]!);
  }
  return [...ids];
};

async function tourKeys(
  store: RestoreStore,
  date: string,
  inSet: Set<string>,
  owner: string,
  tourId: string,
): Promise<string[]> {
  const prefix = `tours/${owner}/${tourId}/`;
  const own = [...inSet].filter((k) => k.startsWith(prefix));
  const [tour, bundle] = await Promise.all([
    readJson(store, backupKey(date, `${prefix}tour.json`)),
    readJson(store, backupKey(date, pubTourKey(tourId))),
  ]);
  const configs = [...new Set([...scenePanoIds(tour), ...scenePanoIds(bundle)])]
    .map((p) => `panos/${owner}/${p}/config.json`)
    .filter((k) => inSet.has(k));
  return [...own, ...configs, ...(await tourPublicKeys(store, date, inSet, owner, tourId))];
}

export interface RestorePlan {
  /** Original keys to restore, private ones first. */
  keys: string[];
  /** One line each, for the operator. */
  notes: string[];
}

// Private records before the public ones that point at them.
const ORDER = ['tours/', 'panos/', 'tour-owners/', 'pub/', 'slugs/', 'explore/'];
const rank = (k: string): number => {
  const i = ORDER.findIndex((p) => k.startsWith(p));
  return i === -1 ? ORDER.length : i;
};
const ordered = (keys: Iterable<string>): string[] =>
  [...new Set(keys)]
    .filter(isRestorableKey)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

/**
 * What to restore for the scope, from the day's set. Refuses an owner whose account is
 * marked for deletion now (the daily sweep would delete a restore again); a whole-bucket
 * restore leaves such owners out, with their tours' public keys.
 */
export async function planRestore(
  store: RestoreStore,
  date: string,
  scope: RestoreScope,
): Promise<RestorePlan> {
  const [inSet, deleted] = await Promise.all([setKeys(store, date), deletedOwners(store)]);
  if (inSet.size === 0) throw new Error(`no backup set for ${date} (see --list)`);
  const notes: string[] = [];
  const refuseDeleted = (owner: string, who: string) => {
    if (deleted.has(owner)) {
      throw new Error(
        `${who}'s account is marked for deletion: the daily sweep would delete a restore again. Nothing done.`,
      );
    }
  };
  const disabledNote = (owner: string) => {
    if (inSet.has(`${ACCOUNTS_ROOT}${owner}/disabled.json`)) {
      notes.push(
        'the owner was disabled on that date; markers are never restored (takedown.ts --disable-owner blocks them again)',
      );
    }
  };

  if (scope.kind === 'tour') {
    let owner: string;
    if (scope.sub !== undefined) {
      owner = encodeId(scope.sub);
      if (!tourOwners(inSet, scope.tourId).includes(owner)) {
        throw new Error(`the ${date} set has no tour ${scope.tourId} under --sub ${scope.sub}`);
      }
    } else {
      const owners = tourOwners(inSet, scope.tourId);
      if (owners.length === 0) throw new Error(`the ${date} set has no tour ${scope.tourId}`);
      if (owners.length > 1) {
        throw new Error(`tour ${scope.tourId} is under ${owners.length} owners; pass --sub`);
      }
      owner = owners[0]!;
    }
    refuseDeleted(owner, `tour ${scope.tourId}'s owner`);
    disabledNote(owner);
    return { keys: ordered(await tourKeys(store, date, inSet, owner, scope.tourId)), notes };
  }

  if (scope.kind === 'owner') {
    const owner = encodeId(scope.sub);
    refuseDeleted(owner, scope.sub);
    disabledNote(owner);
    const keys = [...inSet].filter(
      (k) => k.startsWith(`tours/${owner}/`) || k.startsWith(`panos/${owner}/`),
    );
    if (keys.length === 0) throw new Error(`the ${date} set has nothing for ${scope.sub}`);
    for (const tourId of ownerTourIds(inSet, owner)) {
      keys.push(...(await tourPublicKeys(store, date, inSet, owner, tourId)));
    }
    return { keys: ordered(keys), notes };
  }

  const left = new Set([...inSet].filter(isRestorableKey));
  const leftOut = [...deleted].filter(
    (o) => ownerTourIds(inSet, o).length > 0 || [...inSet].some((k) => k.startsWith(`panos/${o}/`)),
  );
  for (const owner of leftOut) {
    for (const k of [...left]) {
      if (k.startsWith(`tours/${owner}/`) || k.startsWith(`panos/${owner}/`)) left.delete(k);
    }
    for (const tourId of ownerTourIds(inSet, owner)) {
      for (const k of await tourPublicKeys(store, date, inSet, owner, tourId)) left.delete(k);
    }
  }
  if (leftOut.length) {
    notes.push(`${leftOut.length} owner(s) left out: their accounts are marked for deletion now`);
  }
  const markers = [...inSet].filter((k) => k.startsWith(ACCOUNTS_ROOT)).length;
  if (markers) notes.push(`${markers} account marker(s) in the set are never restored`);
  return { keys: ordered(left), notes };
}

const HEAD_CONCURRENCY = 8;
// Past this many keys, listing the source prefixes is cheaper than a HEAD per key.
const HEAD_MAX = 1000;

/** Which of `keys` exist in the bucket now. */
export async function existingNow(
  store: RestoreStore,
  keys: readonly string[],
): Promise<Set<string>> {
  if (keys.length > HEAD_MAX) {
    const live = new Set<string>();
    for (const s of BACKUP_SOURCES) {
      for (const o of await store.listObjects(s.prefix)) live.add(o.key);
    }
    return new Set(keys.filter((k) => live.has(k)));
  }
  const found = new Set<string>();
  for (let i = 0; i < keys.length; i += HEAD_CONCURRENCY) {
    await Promise.all(
      keys.slice(i, i + HEAD_CONCURRENCY).map(async (key) => {
        const head = await store.head(key);
        if (head.ok) found.add(key);
        else if (head.status !== 404) throw new Error(`R2 HEAD -> ${head.status}`);
      }),
    );
  }
  return found;
}

/** admin-api's operator restore route, for one batch of keys. */
export async function requestRestore(
  fetchFn: FetchLike,
  api: { origin: string; token: string },
  body: { date: string; keys: string[]; overwrite: boolean },
): Promise<OperatorRestoreOk> {
  const res = await fetchFn(`${api.origin}${OPERATOR_RESTORE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [OPERATOR_TOKEN_HEADER]: api.token },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const hint =
      res.status === 404
        ? ' (check OPERATOR_TOKEN matches the admin-api secret in this env, and that admin-api has the restore route)'
        : '';
    throw new Error(`restore -> ${res.status}${hint}`);
  }
  const parsed = OperatorRestoreOkSchema.safeParse(json);
  if (!parsed.success) throw new Error('restore: unexpected response');
  return parsed.data;
}

export interface RestoreDeps {
  store: RestoreStore;
  fetch: FetchLike;
  log: (line: string) => void;
}

const describeScope = (scope: RestoreScope): string =>
  scope.kind === 'tour'
    ? `tour ${scope.tourId}`
    : scope.kind === 'owner'
      ? `everything of ${scope.sub}`
      : 'the whole bucket';

/**
 * The whole CLI run (restore-backup.ts only parses and wires it). Resolves to the exit
 * code: 1 if any key failed (an R2 error, or a request the route didn't answer), after
 * listing each one; the batches that went through stay restored.
 */
export async function runRestore(args: RestoreArgs, deps: RestoreDeps): Promise<number> {
  const { store, log } = deps;
  const sets = await listBackupSets(store);
  if (args.mode === 'list') {
    if (sets.length === 0) log(`no backup sets in ${args.r2.bucket}`);
    for (const s of sets) log(describeSet(s));
    return 0;
  }
  const set = sets.find((s) => s.date === args.date);
  if (!set) throw new Error(`no backup set for ${args.date} (see --list)`);
  log(describeSet(set));
  if (!set.complete) log('WARNING: a partial set; keys it never reached are not restored');

  const plan = await planRestore(store, args.date, args.scope);
  for (const note of plan.notes) log(note);
  const existing = await existingNow(store, plan.keys);
  const missing = plan.keys.filter((k) => !existing.has(k));
  const send = args.overwrite ? plan.keys : missing;
  for (const key of plan.keys) {
    const what = !existing.has(key) ? 'restore' : args.overwrite ? 'replace' : 'keep (exists)';
    log(`${args.apply ? '' : 'would '}${what} ${key}`);
  }
  log(
    `${describeScope(args.scope)} from ${args.date}: ${plan.keys.length} key(s) in the set, ${missing.length} missing now, ${existing.size} there now${args.overwrite ? ' (replaced)' : ' (left as they are; --overwrite replaces them)'}`,
  );
  if (!args.apply) {
    log(
      `DRY RUN: nothing written to ${args.r2.bucket}; pass --apply to restore ${send.length} key(s)`,
    );
    return 0;
  }
  if (send.length === 0) return 0;

  const total: OperatorRestoreOk = {
    restored: [],
    existing: [],
    missing: [],
    refused: [],
    failed: [],
  };
  for (let i = 0; i < send.length; i += OPERATOR_RESTORE_MAX_KEYS) {
    const keys = send.slice(i, i + OPERATOR_RESTORE_MAX_KEYS);
    let out: OperatorRestoreOk;
    try {
      out = await requestRestore(deps.fetch, args.api!, {
        date: args.date,
        keys,
        overwrite: args.overwrite,
      });
    } catch (e) {
      // The batch's outcome is unknown; carry on with the rest and report these as failed.
      log(
        `a request failed (${e instanceof Error ? e.message : String(e)}); its keys are listed below`,
      );
      total.failed.push(...keys);
      continue;
    }
    for (const k of ['restored', 'existing', 'missing', 'refused', 'failed'] as const)
      total[k].push(...out[k]);
  }
  log(
    `restored ${total.restored.length} key(s); ${total.existing.length} appeared since the plan and were left; ${total.missing.length} gone from the set; ${total.refused.length} refused (account marked for deletion, or no owner found); ${total.failed.length} failed`,
  );
  for (const key of total.refused) log(`refused ${key}`);
  for (const key of total.failed) log(`FAILED ${key}`);
  if (total.restored.some((k) => !k.startsWith('tours/') && !k.startsWith('panos/'))) {
    log(
      'restored share links and bundles are purged from the CDN; Explore catches up within a minute',
    );
  }
  if (total.failed.length) {
    log(
      `${total.failed.length} key(s) failed; run the same command again (create-only keeps what came back)`,
    );
    return 1;
  }
  return 0;
}
