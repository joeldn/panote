import {
  SceneConfigSchema,
  TourDocSchema,
  type SceneConfig,
  type TourDoc,
} from '@internal/contracts';

import { EDITOR_DRAFT_PREFIX } from '@internal/web-kit';

import { isSceneDirty, isTourDirty, panoKey, type DocKey, type EditorDocs } from './model.js';
import { planSave } from './save.js';

// Unsaved edits kept in localStorage: autosaved while editing (a discarded tab, a crash, a
// re-auth redirect), keyed by user and tourId and stamped with each document's ETag so a
// changed server copy is never overwritten without asking.

/** A draft older than this is dropped rather than restored. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface EditorDraft {
  v: 1;
  savedAt: string;
  tour: { etag: string; doc: TourDoc } | null;
  configs: Record<string, { etag: string | null; config: SceneConfig }>;
}

/** `user` is the Auth0 sub, so one browser profile never restores another user's edits. */
export const draftKey = (user: string, tourId: string): string =>
  `${EDITOR_DRAFT_PREFIX}${user}:${tourId}`;

export type DraftWrite = 'clean' | 'stored' | 'failed';

/** Store the dirty documents. `failed` means storage refused them (quota, blocked). */
export function writeDraft(
  storage: DraftStorage,
  user: string,
  docs: EditorDocs,
  now = new Date(),
): DraftWrite {
  const plan = planSave(docs);
  if (!plan.tour && plan.configs.length === 0) return 'clean';
  const draft: EditorDraft = {
    v: 1,
    savedAt: now.toISOString(),
    tour: plan.tour,
    configs: Object.fromEntries(
      plan.configs.map(({ panoId, config, etag }) => [panoId, { etag, config }]),
    ),
  };
  try {
    storage.setItem(draftKey(user, docs.tourId), JSON.stringify(draft));
    return 'stored';
  } catch {
    return 'failed';
  }
}

export function clearDraft(storage: DraftStorage, user: string, tourId: string): void {
  try {
    storage.removeItem(draftKey(user, tourId));
  } catch {
    // Storage unavailable: nothing was stored either.
  }
}

/** The stored draft, or null if absent, unreadable or stale (those are dropped). */
export function readDraft(
  storage: DraftStorage,
  user: string,
  tourId: string,
  now = new Date(),
): EditorDraft | null {
  let raw: string | null;
  try {
    raw = storage.getItem(draftKey(user, tourId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<EditorDraft>;
    if (d.v !== 1 || typeof d.savedAt !== 'string' || typeof d.configs !== 'object' || !d.configs) {
      throw new Error('bad draft');
    }
    const age = now.getTime() - Date.parse(d.savedAt);
    if (!(age <= DRAFT_MAX_AGE_MS)) throw new Error('stale draft');
    const tour = d.tour ?? null;
    if (tour && (typeof tour.etag !== 'string' || !TourDocSchema.safeParse(tour.doc).success)) {
      throw new Error('bad draft tour');
    }
    for (const c of Object.values(d.configs)) {
      if (c.etag !== null && typeof c.etag !== 'string') throw new Error('bad draft etag');
      if (!SceneConfigSchema.safeParse(c.config).success) throw new Error('bad draft config');
    }
    return { v: 1, savedAt: d.savedAt, tour, configs: d.configs };
  } catch {
    clearDraft(storage, user, tourId);
    return null;
  }
}

export interface DraftApplied {
  docs: EditorDocs;
  /** Documents whose edits went back on top of an unchanged server copy. */
  restored: DocKey[];
  /**
   * Documents whose server copy changed since the draft was taken. Their edits are kept,
   * still on the draft's ETag, so Save would 412: the caller opens the conflict banner.
   */
  conflicts: DocKey[];
  /** Documents that are gone (a pano deleted or no longer in the tour); their edits are dropped. */
  discarded: DocKey[];
}

/** Put the draft's edits on top of freshly loaded documents, keeping each draft ETag. */
export function applyDraft(docs: EditorDocs, draft: EditorDraft): DraftApplied {
  const restored: DocKey[] = [];
  const conflicts: DocKey[] = [];
  const discarded: DocKey[] = [];
  const scenes = { ...docs.scenes };
  for (const [panoId, { etag, config }] of Object.entries(draft.configs)) {
    const s = scenes[panoId];
    if (s?.kind !== 'config' || config.panoId !== panoId) {
      discarded.push(panoKey(panoId));
      continue;
    }
    const next = { ...s, etag, current: config };
    // Someone else saved exactly these edits: nothing left to restore.
    if (!isSceneDirty(next)) continue;
    scenes[panoId] = next;
    (s.etag === etag ? restored : conflicts).push(panoKey(panoId));
  }
  let tour = docs.tour;
  if (draft.tour) {
    const next = { ...tour, etag: draft.tour.etag, current: draft.tour.doc };
    if (draft.tour.doc.tourId !== docs.tourId) {
      discarded.push('tour');
    } else if (isTourDirty({ ...docs, tour: next })) {
      tour = next;
      (docs.tour.etag === draft.tour.etag ? restored : conflicts).push('tour');
    }
  }
  return { docs: { ...docs, tour, scenes }, restored, conflicts, discarded };
}
