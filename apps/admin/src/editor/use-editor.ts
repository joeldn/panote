import type { TourPublishState, TourRole } from '@internal/contracts';
import type { AdminApi } from '@internal/web-kit';
import { isAuthError } from '@internal/web-kit';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useBeforeSignIn } from '../before-sign-in.js';
import { applyDraft, clearDraft, readDraft, writeDraft, type DraftStorage } from './draft.js';
import {
  dirtyKeys,
  editorReducer,
  fromServer,
  isTourDirty,
  mergeAppendedScenes,
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
  | 'getTourWithConfigs'
  | 'getTour'
  | 'getPano'
  | 'putTour'
  | 'putPanoConfig'
  | 'createPanoConfig'
  | 'publishTour'
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
  /**
   * A button on the notice: `republish` retries publishing the saved tour, `discard-draft`
   * drops restored unsaved changes and reloads the saved tour.
   */
  action?: 'republish' | 'discard-draft';
}

export type Failures = Partial<Record<DocKey, DocFailure>>;

function browserStorage(): DraftStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** How long after the last edit the draft is written to storage. */
export const AUTOSAVE_DELAY_MS = 1000;

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
    case 'sharing-stopped':
      // Only worth saying when this editor still thought the tour was live.
      return wasPublished
        ? {
            id: 'publish',
            tone: 'info',
            text: 'Saved. Sharing is off for this tour, so its link stays offline.',
            link: { to: 'share/link', label: 'Share' },
          }
        : null;
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
        text: `Saved. The share link wasn’t updated because some panos can’t be published yet: ${names.join(', ')}. Try again once they’re ready.`,
        action: 'republish',
      };
    }
    case 'failed':
      return {
        id: 'publish',
        tone: 'warn',
        text: `Saved, but the share link couldn’t be updated (${out.message}).`,
        action: 'republish',
      };
  }
}

const sceneName = (docs: EditorDocs, panoId: string): string => {
  const s = docs.scenes[panoId];
  return s?.kind === 'config' ? s.current.title : 'Missing pano';
};

/** “Hall”, or “your new panos” for more than one. */
const processingSubject = (docs: EditorDocs, panoIds: string[]): string =>
  panoIds.length === 1 ? `“${sceneName(docs, panoIds[0]!)}” finishes` : 'your new panos finish';

/** A publish that only hit `not-ready`: nothing is wrong, the tiles just aren't there yet. */
function waitingNotice(docs: EditorDocs, panoIds: string[], wasPublished: boolean): EditorNotice {
  const subject = processingSubject(docs, panoIds);
  return {
    id: 'publish',
    tone: 'info',
    text: wasPublished
      ? `Saved. The share link updates as soon as ${subject} processing.`
      : `Saved. Publishing as soon as ${subject} processing.`,
  };
}

/** Load, edit, save (one conditional PUT per dirty doc), publish, and resolve conflicts. */
export function useEditor(
  api: EditorApi,
  tourId: string,
  /** Auth0 sub: parked drafts are per user. */
  user: string,
  storage = browserStorage(),
) {
  const [attempt, setAttempt] = useState(0);
  // Keyed by what was loaded, so a new tourId (or a retry) reads as loading without a reset.
  const loadKey = `${tourId}#${attempt}`;
  const [loaded, setLoaded] = useState<{ key: string; state: LoadState } | null>(null);
  const load: LoadState = loaded?.key === loadKey ? loaded.state : { status: 'loading' };
  const [docs, setDocs] = useState<EditorDocs | null>(null);
  const docsRef = useRef<EditorDocs | null>(null);
  const [failures, setFailuresState] = useState<Failures>({});
  const failuresRef = useRef<Failures>({});
  const setFailures = useCallback((next: Failures | ((f: Failures) => Failures)) => {
    failuresRef.current = typeof next === 'function' ? next(failuresRef.current) : next;
    setFailuresState(failuresRef.current);
  }, []);
  const [publishing, setPublishing] = useState(false);
  // False once a re-auth redirect is going ahead, so it doesn't trip the unload prompt.
  const unloadGuardRef = useRef(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // An appended pano that arrived mid-save, and the sync to run for it after (syncAppended).
  const syncAfterSave = useRef(false);
  const syncRef = useRef<() => Promise<unknown>>(async () => {});
  // Bumped per sync request, save and load; a sync response from before the latest bump is
  // dropped, so it can't undo a save or land in another tour.
  const syncSeq = useRef(0);
  // The seq of the sync whose GET is out, if any: a save that starts meanwhile reruns it.
  const syncInFlight = useRef<number | null>(null);
  // Tour ETags this editor has moved past; a response carrying one is older than what we hold.
  // (Content that repeats can bring an ETag back and drop a valid sync; Save's 412 recovers.)
  const pastTourEtags = useRef(new Set<string>());
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [publish, setPublish] = useState<TourPublishState | null>(null);
  // An editor of someone else's tour: owner-only controls (sharing, delete) stay hidden.
  const [role, setRole] = useState<TourRole>('owner');
  const publishRef = useRef<TourPublishState | null>(null);
  const [notices, setNotices] = useState<EditorNotice[]>([]);
  // The last publish attempt hit only `not-ready` for these panos: once their tiles are
  // in, the editor publishes again by itself (autoRepublish). Null otherwise.
  const [awaitingTiles, setAwaitingState] = useState<string[] | null>(null);
  const awaitingRef = useRef<string[] | null>(null);
  const setAwaiting = useCallback((ids: string[] | null) => {
    awaitingRef.current = ids;
    setAwaitingState(ids);
  }, []);
  const publishingRef = useRef(false);
  // Publishes run one at a time; each takes a number, and a result whose number is no
  // longer the latest (a save started since, say) is dropped rather than applied.
  const publishSeq = useRef(0);
  const publishTail = useRef<Promise<void>>(Promise.resolve());
  const publishCount = useRef(0);
  // True while unsaved changes are being thrown away on purpose: autosave mustn't keep them.
  const draftOffRef = useRef(false);

  // Synchronous so a save started right after an edit sees it.
  const dispatch = useCallback((action: EditorAction) => {
    // A new edit is a new unsaved change worth keeping.
    if (action.type !== 'load') draftOffRef.current = false;
    const prev = docsRef.current?.tour.etag;
    docsRef.current = editorReducer(docsRef.current, action);
    const next = docsRef.current?.tour.etag;
    if (action.type === 'load') pastTourEtags.current.clear();
    else if (prev && prev !== next) pastTourEtags.current.add(prev);
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
    // A sync still out for the previous tour (or load) must not land in this one.
    syncSeq.current++;
    void (async () => {
      try {
        const res = await api.getTourWithConfigs(tourId);
        if (cancelled) return;
        if (res.status !== 'ok') {
          if (storage) clearDraft(storage, user, tourId);
          setLoaded({ key, state: { status: 'not-found' } });
          return;
        }
        let fresh = fromServer(res.data);
        const draft = storage ? readDraft(storage, user, tourId) : null;
        if (storage && draft) {
          const applied = applyDraft(fresh, draft);
          fresh = applied.docs;
          if (applied.restored.length || applied.conflicts.length) {
            notify({
              id: 'draft',
              tone: 'info',
              // Save is blocked while a conflict is open: point at the banner instead.
              text: applied.conflicts.length
                ? 'Restored your unsaved changes. This tour also changed elsewhere, so choose Reload or Overwrite above.'
                : 'Restored your unsaved changes. Save to keep them.',
              action: 'discard-draft',
            });
          }
          if (applied.conflicts.length) {
            // The server copy moved on since the draft: the conflict banner asks which to keep.
            setFailures(
              Object.fromEntries(applied.conflicts.map((k) => [k, { kind: 'conflict' as const }])),
            );
          }
          if (applied.discarded.length) {
            notify({
              id: 'draft-conflict',
              tone: 'warn',
              text: 'Some unsaved changes couldn’t be restored because their pano is no longer in this tour.',
            });
          }
          // Keep only what was restored, so a tab lost right now still has it.
          if (writeDraft(storage, user, fresh) === 'clean') clearDraft(storage, user, tourId);
        }
        dispatch({ type: 'load', docs: fresh });
        publishRef.current = res.data.publish ?? null;
        setPublish(publishRef.current);
        setRole(res.data.role ?? 'owner');
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
  }, [api, tourId, user, storage, dispatch, notify, setFailures, loadKey]);

  useBeforeSignIn({
    prepare: () => {
      if (!docsRef.current) return null;
      const written = storage ? writeDraft(storage, user, docsRef.current) : 'failed';
      if (written !== 'failed') return null;
      return 'Your unsaved changes to this tour couldn’t be kept while you sign in (browser storage is full or blocked), so they would be lost.';
    },
    proceed: () => {
      unloadGuardRef.current = false;
    },
    cancel: () => {
      unloadGuardRef.current = true;
    },
  });

  const dirtyCount = docs ? dirtyKeys(docs).length : 0;
  const ready = load.status === 'ready';
  useEffect(() => {
    if (!dirtyCount) return;
    unloadGuardRef.current = true;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (unloadGuardRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirtyCount]);
  // Nothing unsaved: a parked draft (e.g. from an aborted redirect) is stale.
  useEffect(() => {
    if (ready && dirtyCount === 0 && storage) clearDraft(storage, user, tourId);
  }, [ready, dirtyCount, storage, user, tourId]);

  // Autosave: unsaved edits go to storage shortly after the last change, and at once when
  // the page is hidden or unloaded (a phone may discard a background tab without warning,
  // and iOS mostly skips beforeunload). A full or blocked storage just means no draft.
  const writeNow = useCallback(() => {
    const current = docsRef.current;
    if (!storage || !current || draftOffRef.current) return;
    if (dirtyKeys(current).length === 0) return;
    // Two tabs on one tour share this key and the last write wins: both are this user's
    // edits, and Save's ETag conflict check still guards the server copy.
    writeDraft(storage, user, current);
  }, [storage, user]);
  useEffect(() => {
    if (!ready || !dirtyCount) return;
    const timer = setTimeout(writeNow, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ready, dirtyCount, docs, writeNow]);
  useEffect(() => {
    if (!ready) return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') writeNow();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', writeNow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', writeNow);
    };
  }, [ready, writeNow]);

  /** Leaving without saving: drop the stored draft and keep autosave from writing it again. */
  const forgetDraft = useCallback(() => {
    draftOffRef.current = true;
    if (storage) clearDraft(storage, user, tourId);
  }, [storage, user, tourId]);

  /** `auto`: the editor's own retry once the tiles a `not-ready` publish waited on are in. */
  const republishWith = useCallback(
    async (fallback: EditorDocs, { auto = false } = {}) => {
      const seq = ++publishSeq.current;
      const waitedOn = awaitingRef.current;
      publishCount.current++;
      publishingRef.current = true;
      setPublishing(true);
      const before = publishTail.current;
      let release!: () => void;
      publishTail.current = new Promise<void>((r) => (release = r));
      try {
        // Never two publishes at once: the server would snapshot whichever lands last.
        await before;
        if (seq !== publishSeq.current) return;
        const wasPublished = publishRef.current !== null;
        const published = await runPublish(api, tourId);
        if (published.kind === 'ok') {
          const { slug, visibility, publishedAt } = published.publish;
          publishRef.current = { slug, visibility, publishedAt };
          setPublish(publishRef.current);
        } else if (published.kind === 'sharing-stopped') {
          publishRef.current = null;
          setPublish(null);
        }
        // Superseded (a save started meanwhile): its own publish decides what to show.
        if (seq !== publishSeq.current) return;
        const docsNow = docsRef.current ?? fallback;
        if (published.kind === 'unpublishable' && published.scenes.length > 0) {
          const ids = published.scenes.map((s) => s.panoId);
          const onlyNotReady = published.scenes.every((s) => s.reason === 'not-ready');
          // An automatic retry that finds a pano it thought was ready still not ready
          // doesn't wait again (it would loop): the notice offers Try again instead.
          const again = auto && ids.some((id) => waitedOn?.includes(id));
          if (onlyNotReady && !again) {
            setAwaiting(ids);
            notify(waitingNotice(docsNow, ids, wasPublished));
            return;
          }
        }
        setAwaiting(null);
        if (auto && published.kind === 'ok') {
          notify({
            id: 'publish',
            tone: 'info',
            text: 'Your new panos are processed and the share link is up to date.',
            link: { to: 'share/link', label: 'Share' },
          });
          return;
        }
        const notice = publishNotice(published, docsNow, wasPublished);
        if (notice) notify(notice);
        else dismiss('publish');
      } finally {
        release();
        publishCount.current--;
        if (publishCount.current === 0) {
          publishingRef.current = false;
          setPublishing(false);
        }
      }
    },
    [api, tourId, notify, dismiss, setAwaiting],
  );

  const hasConflict = () => Object.values(failuresRef.current).some((f) => f?.kind === 'conflict');

  /**
   * The tour's 412 came only from scenes an upload appended since this editor last
   * synced (several files uploading in turn make that likely): take them into the draft.
   * False when the tour changed some other way, which stays a real conflict.
   */
  const foldAppends = useCallback(async (): Promise<boolean> => {
    try {
      const res = await api.getTourWithConfigs(tourId);
      const now = docsRef.current;
      if (res.status !== 'ok' || !now) return false;
      const merged = mergeAppendedScenes(now.tour, { etag: res.data.etag, tour: res.data.tour });
      if (!merged) return false;
      dispatch({ type: 'add-scenes', scenes: fromServer(res.data).scenes });
      dispatch({ type: 'replace-doc', key: 'tour', doc: merged });
      return true;
    } catch {
      return false;
    }
  }, [api, tourId, dispatch]);

  /**
   * `resolving` is only for the conflict banner's overwrite; otherwise a conflict blocks saving.
   * Resolves true once everything is saved (or there was nothing to save); false when this
   * save failed in part, couldn't start, or another one was already under way.
   */
  const save = useCallback(
    async ({ resolving = false } = {}): Promise<boolean> => {
      const current = docsRef.current;
      if (!current || savingRef.current) return false;
      if (!resolving && hasConflict()) return false;
      const plan = planSave(current);
      if (isEmptyPlan(plan)) return true;
      savingRef.current = true;
      setSaving(true);
      // A new attempt: whatever the last publish waited on or said, this save's publish
      // decides again, and a publish still out (an automatic one) can't apply its stale
      // result. The old notice's Try again goes too: pressed mid-save, or after some PUTs
      // failed, it would publish a mix of new and old documents.
      publishSeq.current++;
      setAwaiting(null);
      dismiss('publish');
      // A sync whose GET is already out could answer with the pre-save tour: drop it and rerun.
      syncSeq.current++;
      if (syncInFlight.current !== null) syncAfterSave.current = true;
      try {
        // Its PUTs wait for a publish already out, so that publish can't snapshot them halfway.
        await publishTail.current;
        const out = await runSave(api, tourId, plan);
        dispatch({ type: 'saved', ...(out.tour && { tour: out.tour }), configs: out.configs });
        // A scene appended under this save: fold it in and send the tour once more.
        if (out.failures.tour?.kind === 'conflict' && (await foldAppends())) {
          const again = planSave(docsRef.current!);
          const retry = again.tour ? await runSave(api, tourId, { ...again, configs: [] }) : null;
          if (retry?.tour) dispatch({ type: 'saved', tour: retry.tour, configs: {} });
          delete out.failures.tour;
          if (retry?.failures.tour) out.failures.tour = retry.failures.tour;
        }
        setFailures(out.failures);
        if (Object.keys(out.failures).length > 0) return false;
        setSavedAt(new Date());
        dismiss('draft');
        if (storage) clearDraft(storage, user, tourId);
        // Publish failures never turn a successful save into a failed one.
        await republishWith(current);
        return true;
      } finally {
        savingRef.current = false;
        setSaving(false);
        if (syncAfterSave.current) {
          syncAfterSave.current = false;
          void syncRef.current();
        }
      }
    },
    [
      api,
      tourId,
      user,
      storage,
      dispatch,
      dismiss,
      setFailures,
      republishWith,
      setAwaiting,
      foldAppends,
    ],
  );

  /**
   * The upload chip appended a pano to this tour: take the server's tour (and the new
   * scene's config) the way the conflict Reload does, keeping local edits, so the next
   * Save doesn't 412. If the tour also changed some other way while edited here, that's
   * a real conflict and the conflict banner takes over.
   * Resolves false when the server's tour couldn't be read (nothing was folded in);
   * true otherwise, including when a newer sync or save takes over.
   */
  const syncAppended = useCallback(async (): Promise<boolean> => {
    if (!docsRef.current) return false;
    // A save in flight would move the ETag under us: run once it settles.
    if (savingRef.current) {
      syncAfterSave.current = true;
      return true;
    }
    const seq = ++syncSeq.current;
    syncInFlight.current = seq;
    try {
      const res = await api.getTourWithConfigs(tourId);
      const now = docsRef.current;
      if (seq !== syncSeq.current || !now) return true;
      if (res.status !== 'ok') return false;
      if (res.data.tour.tourId !== now.tourId) return true;
      if (pastTourEtags.current.has(res.data.etag)) return true;
      const fresh = fromServer(res.data);
      dispatch({ type: 'add-scenes', scenes: fresh.scenes });
      if (failuresRef.current.tour?.kind === 'conflict' || fresh.tour.etag === now.tour.etag) {
        return true;
      }
      const merged = mergeAppendedScenes(now.tour, {
        etag: fresh.tour.etag,
        tour: fresh.tour.base,
      });
      if (merged) dispatch({ type: 'replace-doc', key: 'tour', doc: merged });
      else if (!isTourDirty(now)) dispatch({ type: 'replace-doc', key: 'tour', doc: fresh.tour });
      else setFailures((f) => ({ ...f, tour: { kind: 'conflict' } }));
      return true;
    } catch {
      // Best effort: Save's 412 handling still covers it.
      return false;
    } finally {
      if (syncInFlight.current === seq) syncInFlight.current = null;
    }
  }, [api, tourId, dispatch, setFailures]);
  useEffect(() => {
    syncRef.current = syncAppended;
  });

  /** The share modal changed sharing (shared again, or stopped): the editor follows it. */
  const setShared = useCallback(
    (next: TourPublishState | null) => {
      publishRef.current = next;
      setPublish(next);
      // Whatever the last publish said or waited on is moot once sharing changed by hand.
      setAwaiting(null);
      dismiss('publish');
    },
    [dismiss, setAwaiting],
  );

  /**
   * Why nothing may publish the saved tour right now, or null when it may. Mid-save, or
   * after a save that failed in part, the server holds a mix of new and old documents.
   */
  const publishBlocked = useCallback(
    (): string | null =>
      savingRef.current || Object.keys(failuresRef.current).length > 0
        ? 'Save your changes first.'
        : null,
    [],
  );

  /** The publish notice's "Try again": publishes the already-saved tour, unless blocked. */
  const republish = useCallback(async () => {
    if (publishBlocked() !== null) return;
    if (docsRef.current) await republishWith(docsRef.current);
  }, [publishBlocked, republishWith]);

  /**
   * The tiles the last publish waited on are all in: publish again. A no-op unless that
   * publish hit `not-ready` and nothing has been tried since (a save attempt clears it),
   * while another publish is under way, or while a save failed or a conflict is open.
   */
  const autoRepublish = useCallback(async () => {
    // (A save clears `awaitingRef` before it starts, so there's no save to wait out here.)
    if (!awaitingRef.current || publishingRef.current) return;
    // A failed save or an open conflict: the saved tour isn't what the user is editing.
    if (Object.keys(failuresRef.current).length > 0) return;
    if (docsRef.current) await republishWith(docsRef.current, { auto: true });
  }, [republishWith]);

  /** A pano the last publish waited on failed: stop waiting, and say what to do. */
  const tilesFailed = useCallback(
    (panoIds: string[]) => {
      if (!awaitingRef.current) return;
      setAwaiting(null);
      const docsNow = docsRef.current;
      const names = docsNow
        ? panoIds.map((id) => `“${sceneName(docsNow, id)}”`).join(', ')
        : 'A pano';
      const one = panoIds.length === 1;
      notify({
        id: 'publish',
        tone: 'warn',
        text: `${names} couldn’t be processed, so the share link wasn’t updated. Replace ${one ? 'its image' : 'their images'} or remove ${one ? 'it' : 'them'} from the tour, then try again.`,
        action: 'republish',
      });
    },
    [notify, setAwaiting],
  );

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
      const res = await api.getPano(panoId, { tourId });
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
      for (const key of keys) {
        if (key === 'tour') {
          // The other copy may list scenes this editor never loaded: fetch their configs too.
          const res = await api.getTourWithConfigs(tourId);
          if (res.status !== 'ok') throw new Error('This tour no longer exists.');
          const fresh = fromServer(res.data);
          dispatch({ type: 'replace-doc', key, doc: fresh.tour });
          dispatch({ type: 'add-scenes', scenes: fresh.scenes });
        } else {
          dispatch({ type: 'replace-doc', key, doc: (await fetchDoc(key)).doc });
        }
      }
      setFailures((f) => {
        const next = { ...f };
        for (const k of keys) delete next[k];
        return next;
      });
    } catch (e) {
      notify({ id: 'conflict-error', tone: 'warn', text: (e as Error).message });
    }
  }, [api, tourId, failures, fetchDoc, dispatch, notify, setFailures]);

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
    await save({ resolving: true });
  }, [failures, fetchDoc, dispatch, notify, dismiss, save]);

  /** The restored-draft notice's Discard: drop every unsaved change and take the saved tour. */
  const discardDraft = useCallback(async () => {
    if (savingRef.current) return;
    forgetDraft();
    try {
      const res = await api.getTourWithConfigs(tourId);
      // A save started during the fetch wins: its result is what the editor now holds.
      if (savingRef.current) {
        draftOffRef.current = false;
        writeNow();
        return;
      }
      if (res.status !== 'ok') throw new Error('This tour no longer exists.');
      // A sync still out would land on the fresh copy as if it were older: drop it.
      syncSeq.current++;
      dispatch({ type: 'load', docs: fromServer(res.data) });
      setFailures({});
      publishRef.current = res.data.publish ?? null;
      setPublish(publishRef.current);
      dismiss('draft');
      dismiss('draft-conflict');
      dismiss('conflict-error');
    } catch (e) {
      // The edits are still on screen: keep autosaving them.
      draftOffRef.current = false;
      writeNow();
      notify({
        id: 'draft',
        tone: 'warn',
        text: `Your unsaved changes couldn’t be discarded (${(e as Error).message}). Try again.`,
        action: 'discard-draft',
      });
    }
  }, [api, tourId, forgetDraft, writeNow, dispatch, setFailures, dismiss, notify]);

  const dirty = docs ? dirtyKeys(docs) : [];

  return {
    load,
    role,
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
    setShared,
    publishBlocked,
    republish,
    publishing,
    awaitingTiles,
    autoRepublish,
    tilesFailed,
    notices,
    notify,
    dismiss,
    syncAppended,
    discardDraft,
    forgetDraft,
  };
}

export type EditorController = ReturnType<typeof useEditor>;
