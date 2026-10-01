import {
  SceneConfigSchema,
  TourDocSchema,
  type SceneConfig,
  type TourDoc,
} from '@internal/contracts';

import { panoKey, type DocKey, type EditorDocs } from './model.js';
import { planSave } from './save.js';

// Unsaved edits parked in localStorage across a re-auth redirect, keyed by user and
// tourId and stamped with each document's ETag so a changed server copy is never overwritten.

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface EditorDraft {
  v: 1;
  savedAt: string;
  tour: { etag: string; doc: TourDoc } | null;
  configs: Record<string, { etag: string | null; config: SceneConfig }>;
}

const PREFIX = 'panote:editor-draft:';

/** `user` is the Auth0 sub, so one browser profile never restores another user's edits. */
export const draftKey = (user: string, tourId: string): string => `${PREFIX}${user}:${tourId}`;

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

/** The stored draft, or null if absent or unreadable (an unreadable one is dropped). */
export function readDraft(storage: DraftStorage, user: string, tourId: string): EditorDraft | null {
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

/** Drop every parked draft in this browser (on sign-out). */
export function sweepDrafts(storage?: Pick<Storage, 'length' | 'key' | 'removeItem'>): void {
  try {
    const store = storage ?? window.localStorage;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) store.removeItem(k);
  } catch {
    // Storage unavailable: nothing is parked there either.
  }
}
