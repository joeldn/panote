import type { UploadMode } from '@internal/web-kit';

/** Where an upload's pano goes: a new tour, an existing tour, or over an existing pano's image. */
export type UploadTarget =
  { kind: 'new-tour' } | { kind: 'add'; tourId: string } | { kind: 'replace'; panoId: string };

/**
 * What survives a sign-in redirect. The File can't, so `landed` (the image already
 * reached R2) decides between resuming the poll and asking for the file again.
 */
export interface ResumeRecord {
  v: 1;
  fileName: string;
  target: UploadTarget;
  landed: { panoId: string; mode: UploadMode } | null;
  savedAt: number;
}

const KEY = 'panote.upload.resume';
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
  if (v.kind === 'replace' && typeof v.panoId === 'string' && ID.test(v.panoId)) {
    return { kind: 'replace', panoId: v.panoId };
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
  if (replace !== null && ID.test(replace)) return { kind: 'replace', panoId: replace };
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
  if (!isObj(v) || v.v !== 1 || typeof v.fileName !== 'string') return null;
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
  return { v: 1, fileName: v.fileName.slice(0, 200), target, landed, savedAt: v.savedAt };
}

// sessionStorage: same tab only (the Auth0 redirect stays in the tab), gone when it closes.
const storage = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

export function readResumeRecord(now = Date.now()): ResumeRecord | null {
  try {
    return parseResumeRecord(storage()?.getItem(KEY) ?? null, now);
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
