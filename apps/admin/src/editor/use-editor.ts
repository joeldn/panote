import type { TourPublishState } from '@internal/contracts';
import type { AdminApi } from '@internal/web-kit';
import { isAuthError } from '@internal/web-kit';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useBeforeSignIn } from '../before-sign-in.js';
import { applyDraft, clearDraft, readDraft, writeDraft, type DraftStorage } from './draft.js';
import {
  dirtyKeys,
  editorReducer,
  fromServer,
  panoIdOf,
  UNTITLED_PANO,
  type DocKey,
  type EditorAction,
  type EditorDocs,
  type SceneState,
} from './model.js';
import {
  isEmptyPlan,
  planSave,
  runPublish,
  runSave,
  type DocFailure,
  type PublishOutcome,
} from './save.js';

export type EditorApi = Pick<
  AdminApi,
  'getTourWithConfigs' | 'getTour' | 'getPano' | 'putTour' | 'putPanoConfig' | 'publishTour'
>;

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

export interface EditorNotice {
  id: string;
  tone: 'info' | 'warn';
  text: string;
  /** In-editor route (relative to the tour), e.g. `share/link`. */
  link?: { to: string; label: string };
}

export type Failures = Partial<Record<DocKey, DocFailure>>;

function browserStorage(): DraftStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const describeScenes = (docs: EditorDocs, keys: DocKey[]): string =>
  keys
    .map((k) => {
      const id = panoIdOf(k);
      if (id === null) return 'the tour details';
      const s = docs.scenes[id];
      return s?.kind === 'config' ? `“${s.current.title}”` : 'a pano';
    })
    .join(', ');

const REASONS: Record<string, string> = {
  'not-ready': 'still processing',
  missing: 'missing',
  deleting: 'being deleted',
  'not-owned': 'not in your account',
};

function publishNotice(
  out: PublishOutcome,
  docs: EditorDocs,
  wasPublished: boolean,
): EditorNotice | null {
  switch (out.kind) {
    case 'ok':
      return wasPublished
        ? null
        : {
            id: 'publish',
            tone: 'info',
            text: 'Saved. Your tour is now live for anyone with the link (unlisted).',
            link: { to: 'share/link', label: 'Share' },
          };
    case 'slug-lost':
      return {
        id: 'publish',
        tone: 'warn',
        text: 'Saved. Another tour now uses this tour’s link, so the share link needs a new address.',
        link: { to: 'share/link', label: 'Pick a new link' },
      };
    case 'unpublishable': {
      if (out.scenes.length === 0) {
        return { id: 'publish', tone: 'info', text: 'Saved. Add a pano to put this tour online.' };
      }
      const names = out.scenes.map((s) => {
        const scene = docs.scenes[s.panoId];
        const name = scene?.kind === 'config' ? scene.current.title : 'Missing pano';
        return `${name} (${REASONS[s.reason] ?? s.reason})`;
      });
      return {
        id: 'publish',
        tone: 'warn',
        text: `Saved. The share link wasn’t updated because some panos can’t be published yet: ${names.join(', ')}.`,
      };
    }
    case 'failed':
      return {
        id: 'publish',
        tone: 'warn',
        text: `Saved, but the share link couldn’t be updated (${out.message}). It updates on your next save.`,
      };
  }
}

/** Load, edit, save (one conditional PUT per dirty doc), publish, and resolve conflicts. */
export function useEditor(api: EditorApi, tourId: string, storage = browserStorage()) {
  const [attempt, setAttempt] = useState(0);
  // Keyed by what was loaded, so a new tourId (or a retry) reads as loading without a reset.
  const loadKey = `${tourId}#${attempt}`;
  const [loaded, setLoaded] = useState<{ key: string; state: LoadState } | null>(null);
  const load: LoadState = loaded?.key === loadKey ? loaded.state : { status: 'loading' };
  const [docs, setDocs] = useState<EditorDocs | null>(null);
  const docsRef = useRef<EditorDocs | null>(null);
  const [failures, setFailures] = useState<Failures>({});
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [publish, setPublish] = useState<TourPublishState | null>(null);
  const publishRef = useRef<TourPublishState | null>(null);
  const [notices, setNotices] = useState<EditorNotice[]>([]);

  // Synchronous so a save started right after an edit sees it.
  const dispatch = useCallback((action: EditorAction) => {
    docsRef.current = editorReducer(docsRef.current, action);
    setDocs(docsRef.current);
  }, []);

  const notify = useCallback((n: EditorNotice) => {
    setNotices((all) => [...all.filter((x) => x.id !== n.id), n]);
  }, []);
  const dismiss = useCallback((id: string) => {
    setNotices((all) => all.filter((x) => x.id !== id));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const key = loadKey;
    void (async () => {
      try {
        const res = await api.getTourWithConfigs(tourId);
        if (cancelled) return;
        if (res.status !== 'ok') {
          setLoaded({ key, state: { status: 'not-found' } });
          return;
        }
        let fresh = fromServer(res.data);
        const draft = storage ? readDraft(storage, tourId) : null;
        if (draft) {
          const applied = applyDraft(fresh, draft);
          fresh = applied.docs;
          if (applied.restored.length) {
            notify({
              id: 'draft',
              tone: 'info',
              text: 'Restored your unsaved changes from before you signed in again. Save to keep them.',
            });
          }
          if (applied.discarded.length) {
            notify({
              id: 'draft-conflict',
              tone: 'warn',
              text: `Some unsaved changes were dropped because ${describeScenes(fresh, applied.discarded)} changed elsewhere while you were signed out.`,
            });
          }
          clearDraft(storage!, tourId);
        }
        dispatch({ type: 'load', docs: fresh });
        publishRef.current = res.data.publish ?? null;
        setPublish(publishRef.current);
        setLoaded({ key, state: { status: 'ready' } });
      } catch (e) {
        if (cancelled) return;
        const message = isAuthError(e) ? 'Sign in again to load this tour.' : (e as Error).message;
        setLoaded({ key, state: { status: 'error', message } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, tourId, storage, dispatch, notify, loadKey]);

  useBeforeSignIn(() => {
    if (storage && docsRef.current) writeDraft(storage, docsRef.current);
  });

  const save = useCallback(async () => {
    const current = docsRef.current;
    if (!current || savingRef.current) return;
    const plan = planSave(current);
    if (isEmptyPlan(plan)) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const out = await runSave(api, tourId, plan);
      dispatch({ type: 'saved', ...(out.tour && { tour: out.tour }), configs: out.configs });
      setFailures(out.failures);
      if (Object.keys(out.failures).length > 0) return;
      setSavedAt(new Date());
      dismiss('draft');
      // Publish failures never turn a successful save into a failed one.
      const wasPublished = publishRef.current !== null;
      const published = await runPublish(api, tourId);
      if (published.kind === 'ok') {
        const { slug, visibility, publishedAt } = published.publish;
        publishRef.current = { slug, visibility, publishedAt };
        setPublish(publishRef.current);
      }
      const notice = publishNotice(published, docsRef.current ?? current, wasPublished);
      if (notice) notify(notice);
      else dismiss('publish');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [api, tourId, dispatch, notify, dismiss]);

  /** Fetch the server's copy of one document: its ETag and contents. */
  const fetchDoc = useCallback(
    async (key: DocKey): Promise<{ etag: string | null; doc: EditorDocs['tour'] | SceneState }> => {
      const panoId = panoIdOf(key);
      if (panoId === null) {
        const res = await api.getTour(tourId);
        if (res.status !== 'ok') throw new Error('This tour no longer exists.');
        const { tour, etag } = res.data;
        return { etag, doc: { etag, base: tour, current: tour } };
      }
      const res = await api.getPano(panoId);
      if (res.status === 'ok') {
        const { config, etag } = res.data;
        return { etag, doc: { kind: 'config', etag, base: config, current: config } };
      }
      if (res.status === 'not-found' && res.hasOriginal && !res.deleting) {
        const blank = { panoId, title: UNTITLED_PANO, hotspots: [] };
        return { etag: null, doc: { kind: 'config', etag: null, base: blank, current: blank } };
      }
      if (res.status === 'not-found') {
        return { etag: null, doc: { kind: 'missing', deleting: res.deleting } };
      }
      throw new Error('Unexpected response.');
    },
    [api, tourId],
  );

  const conflicts = (Object.keys(failures) as DocKey[]).filter(
    (k) => failures[k]?.kind === 'conflict',
  );

  /** 412 recovery: drop local edits to the conflicting docs and take the server's. */
  const reloadConflicts = useCallback(async () => {
    const keys = (Object.keys(failures) as DocKey[]).filter(
      (k) => failures[k]?.kind === 'conflict',
    );
    try {
      for (const key of keys)
        dispatch({ type: 'replace-doc', key, doc: (await fetchDoc(key)).doc });
      setFailures((f) => {
        const next = { ...f };
        for (const k of keys) delete next[k];
        return next;
      });
    } catch (e) {
      notify({ id: 'conflict-error', tone: 'warn', text: (e as Error).message });
    }
  }, [failures, fetchDoc, dispatch, notify]);

  /** 412 recovery: keep local edits and retry with the fresh ETag (never `*` for an existing doc). */
  const overwriteConflicts = useCallback(async () => {
    const keys = (Object.keys(failures) as DocKey[]).filter(
      (k) => failures[k]?.kind === 'conflict',
    );
    try {
      for (const key of keys) {
        const fresh = await fetchDoc(key);
        if ('kind' in fresh.doc && fresh.doc.kind === 'missing') {
          throw new Error(
            'That pano was deleted elsewhere, so it can’t be overwritten. Reload instead.',
          );
        }
        dispatch({ type: 'etag', key, etag: fresh.etag });
      }
    } catch (e) {
      notify({ id: 'conflict-error', tone: 'warn', text: (e as Error).message });
      return;
    }
    dismiss('conflict-error');
    await save();
  }, [failures, fetchDoc, dispatch, notify, dismiss, save]);

  const dirty = docs ? dirtyKeys(docs) : [];

  return {
    load,
    retryLoad: () => setAttempt((n) => n + 1),
    docs,
    dispatch,
    dirty,
    save,
    saving,
    savedAt,
    failures,
    conflicts,
    reloadConflicts,
    overwriteConflicts,
    publish,
    notices,
    dismiss,
  };
}

export type EditorController = ReturnType<typeof useEditor>;
