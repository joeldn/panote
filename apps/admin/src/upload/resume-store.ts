import type { UploadMode } from '@internal/web-kit';

/** Where an upload's pano goes: a new tour, an existing tour, or over an existing pano's image. */
export type UploadTarget =
  | { kind: 'new-tour' }
  | { kind: 'add'; tourId: string }
  | { kind: 'replace'; panoId: string; tourId: string };

/**
 * What survives a sign-in redirect. The File can't, so `landed` (the image already
 * reached R2) decides between resuming the poll and asking for the file again.
 */
export interface ResumeRecord {
  v: 1;
  /** The `sub` of the user it belongs to; another user signing in drops it. */
  owner: string;
  fileName: string;
  target: UploadTarget;
  landed: { panoId: string; mode: UploadMode } | null;
  /**
   * An added pano's config and tour write already went through (they run as soon as
   * the image lands), so a resume only polls: it must not append a scene the user
   * may have removed since. Absent in older records, which append again (idempotent).
   */
  appended?: boolean;
  savedAt: number;
}

const KEY = 'panote.upload.resume';
// Landed uploads finishing in the background, each with its own record so the foreground
// upload's record (KEY) never overwrites or clears theirs.
const BG_KEY = 'panote.upload.resume.bg';
/** A record older than this is stale (the user wandered off); it is dropped. */
export const RESUME_MAX_AGE_MS = 60 * 60_000;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function parseTarget(v: unknown): UploadTarget | null {
  if (!isObj(v)) return null;
  if (v.kind === 'new-tour') return { kind: 'new-tour' };
  if (v.kind === 'add' && typeof v.tourId === 'string' && ID.test(v.tourId)) {
    return { kind: 'add', tourId: v.tourId };
  }
  if (
    v.kind === 'replace' &&
    typeof v.panoId === 'string' &&
    ID.test(v.panoId) &&
    typeof v.tourId === 'string' &&
    ID.test(v.tourId)
  ) {
    return { kind: 'replace', panoId: v.panoId, tourId: v.tourId };
  }
  return null;
}

function parseMode(v: unknown): UploadMode | null {
  if (!isObj(v)) return null;
  if (v.kind === 'fresh') return { kind: 'fresh' };
  if (
    v.kind === 'replace' &&
    (v.baselineVersion === null || typeof v.baselineVersion === 'string')
  ) {
    return { kind: 'replace', baselineVersion: v.baselineVersion };
  }
  return null;
}

/** `/app/new?tour=<id>` adds to that tour, `&replace=<panoId>` replaces that pano's image. */
export function targetFromParams(params: URLSearchParams): UploadTarget {
  const tour = params.get('tour');
  const replace = params.get('replace');
  if (tour === null || !ID.test(tour)) return { kind: 'new-tour' };
  if (replace !== null && ID.test(replace)) {
    return { kind: 'replace', panoId: replace, tourId: tour };
  }
  return { kind: 'add', tourId: tour };
}

/** Validates a stored record field by field; anything off reads as "no record". */
export function parseResumeRecord(raw: string | null, now: number): ResumeRecord | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseRecord(v, now);
}

function parseRecord(v: unknown, now: number): ResumeRecord | null {
  if (!isObj(v) || v.v !== 1 || typeof v.fileName !== 'string') return null;
  if (typeof v.owner !== 'string' || v.owner.length === 0) return null;
  if (typeof v.savedAt !== 'number' || now - v.savedAt > RESUME_MAX_AGE_MS || v.savedAt > now) {
    return null;
  }
  const target = parseTarget(v.target);
  if (!target) return null;
  let landed: ResumeRecord['landed'] = null;
  if (v.landed !== null) {
    if (!isObj(v.landed) || typeof v.landed.panoId !== 'string' || !ID.test(v.landed.panoId)) {
      return null;
    }
    const mode = parseMode(v.landed.mode);
    if (!mode) return null;
    landed = { panoId: v.landed.panoId, mode };
  }
  return {
    v: 1,
    owner: v.owner,
    fileName: v.fileName.slice(0, 200),
    target,
    landed,
    ...(landed && v.appended === true && { appended: true }),
    savedAt: v.savedAt,
  };
}

// sessionStorage: same tab only (the Auth0 redirect stays in the tab), gone when it closes.
const storage = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

/** A stored record that doesn't parse (stale, or from an older build) is removed, not kept. */
export function readResumeRecord(now = Date.now()): ResumeRecord | null {
  try {
    const raw = storage()?.getItem(KEY) ?? null;
    const record = parseResumeRecord(raw, now);
    if (raw !== null && !record) clearResumeRecord();
    return record;
  } catch {
    return null;
  }
}

export function writeResumeRecord(record: Omit<ResumeRecord, 'v' | 'savedAt'>): void {
  try {
    storage()?.setItem(KEY, JSON.stringify({ v: 1, ...record, savedAt: Date.now() }));
  } catch {
    // Private mode or full storage: the user re-picks the file after sign-in.
  }
}

export function clearResumeRecord(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

/** A landed upload's record for the background slot (one per landed panoId). */
export type BackgroundRecord = ResumeRecord & { landed: NonNullable<ResumeRecord['landed']> };

function readBackgroundList(now: number): { raw: unknown[]; records: BackgroundRecord[] } {
  let raw: unknown[] = [];
  try {
    const v: unknown = JSON.parse(storage()?.getItem(BG_KEY) ?? '[]');
    if (Array.isArray(v)) raw = v;
  } catch {
    // Unreadable: treated as empty and rewritten on the next change.
  }
  const records = raw
    .map((v) => parseRecord(v, now))
    .filter((r): r is BackgroundRecord => r?.landed != null);
  return { raw, records };
}

function writeBackgroundList(records: BackgroundRecord[]): void {
  try {
    if (records.length) storage()?.setItem(BG_KEY, JSON.stringify(records));
    else storage()?.removeItem(BG_KEY);
  } catch {
    // Private mode or full storage: that upload just won't resume after a reload.
  }
}

/** The background records still valid; stale or unparseable ones are removed. */
export function readBackgroundRecords(now = Date.now()): BackgroundRecord[] {
  const { raw, records } = readBackgroundList(now);
  if (records.length !== raw.length) writeBackgroundList(records);
  return records;
}

export function writeBackgroundRecord(record: Omit<BackgroundRecord, 'v' | 'savedAt'>): void {
  const now = Date.now();
  const others = readBackgroundList(now).records.filter(
    (r) => r.landed.panoId !== record.landed.panoId,
  );
  writeBackgroundList([...others, { v: 1, ...record, savedAt: now }]);
}

export function clearBackgroundRecord(panoId: string): void {
  const { records } = readBackgroundList(Date.now());
  writeBackgroundList(records.filter((r) => r.landed.panoId !== panoId));
}
