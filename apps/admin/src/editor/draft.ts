import {
  SceneConfigSchema,
  TourDocSchema,
  type SceneConfig,
  type TourDoc,
} from '@internal/contracts';

import { panoKey, type DocKey, type EditorDocs } from './model.js';
import { planSave } from './save.js';

// Unsaved edits parked in localStorage across a re-auth redirect, keyed by tourId
// and stamped with each document's ETag so a changed server copy is never overwritten.

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface EditorDraft {
  v: 1;
  savedAt: string;
  tour: { etag: string; doc: TourDoc } | null;
  configs: Record<string, { etag: string | null; config: SceneConfig }>;
}

export const draftKey = (tourId: string): string => `panote:editor-draft:${tourId}`;

/** Store the dirty documents; returns false when there was nothing to store. */
export function writeDraft(storage: DraftStorage, docs: EditorDocs, now = new Date()): boolean {
  const plan = planSave(docs);
  if (!plan.tour && plan.configs.length === 0) return false;
  const draft: EditorDraft = {
    v: 1,
    savedAt: now.toISOString(),
    tour: plan.tour,
    configs: Object.fromEntries(
      plan.configs.map(({ panoId, config, etag }) => [panoId, { etag, config }]),
    ),
  };
  try {
    storage.setItem(draftKey(docs.tourId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(storage: DraftStorage, tourId: string): void {
  try {
    storage.removeItem(draftKey(tourId));
  } catch {
    // Storage unavailable: nothing was stored either.
  }
}

/** The stored draft, or null if absent or unreadable (an unreadable one is dropped). */
export function readDraft(storage: DraftStorage, tourId: string): EditorDraft | null {
  let raw: string | null;
  try {
    raw = storage.getItem(draftKey(tourId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<EditorDraft>;
    if (d.v !== 1 || typeof d.savedAt !== 'string' || typeof d.configs !== 'object' || !d.configs) {
      throw new Error('bad draft');
    }
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
    clearDraft(storage, tourId);
    return null;
  }
}

export interface DraftApplied {
  docs: EditorDocs;
  restored: DocKey[];
  /** Documents whose server copy changed since the draft was taken; their edits are dropped. */
  discarded: DocKey[];
}

/** Put the draft's edits on top of freshly loaded documents, only where the ETag still matches. */
export function applyDraft(docs: EditorDocs, draft: EditorDraft): DraftApplied {
  const restored: DocKey[] = [];
  const discarded: DocKey[] = [];
  const scenes = { ...docs.scenes };
  for (const [panoId, { etag, config }] of Object.entries(draft.configs)) {
    const s = scenes[panoId];
    if (s?.kind === 'config' && s.etag === etag && config.panoId === panoId) {
      scenes[panoId] = { ...s, current: config };
      restored.push(panoKey(panoId));
    } else {
      discarded.push(panoKey(panoId));
    }
  }
  let tour = docs.tour;
  if (draft.tour) {
    if (draft.tour.etag === docs.tour.etag && draft.tour.doc.tourId === docs.tourId) {
      tour = { ...tour, current: draft.tour.doc };
      restored.push('tour');
    } else {
      discarded.push('tour');
    }
  }
  return { docs: { ...docs, tour, scenes }, restored, discarded };
}
