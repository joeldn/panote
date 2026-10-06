import './upload.css';

import {
  createUploadDeps,
  isAuthError,
  refreshManifestCache,
  startUpload,
  tilesBaseUrl,
  type UploadController,
  type UploadDeps,
  type UploadFileSource,
  type UploadMode,
  type UploadResumeSource,
  type UploadState,
} from '@internal/web-kit';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useAuthEnv } from '../auth-context.js';
import { ConfigContext } from '../config-context.js';
import { useSession } from '../session.js';

import {
  chipModel,
  type ActiveUpload,
  type ChipActionId,
  type FinalizeState,
} from './chip-model.js';
import { addPanoToTour, assertTourHasRoom, FinalizeError, titleFromFileName } from './finalize.js';
import { repickNotice } from './repick-notice.js';
import {
  clearResumeRecord,
  readResumeRecord,
  writeResumeRecord,
  type UploadTarget,
} from './resume-store.js';
import {
  idbPendingUploads,
  UploadEnvContext,
  UploadsContext,
  type PanoTarget,
  type Uploads,
} from './upload-context.js';
import { UploadChip } from './UploadChip.js';
import { UploadOverlay } from './UploadOverlay.js';

/** How long the "ready" chip stays up before it tidies itself away. */
export const READY_CHIP_MS = 8_000;

type Source = Omit<UploadFileSource, 'file'> | UploadResumeSource;

type Manifest = Extract<UploadState, { phase: 'ready' }>['manifest'];

type Landed = { panoId: string; mode: UploadMode };

/** One upload. The chip shows the foreground job; a hidden one keeps working in the background. */
interface Job {
  key: number;
  file: File | null;
  fileName: string;
  target: PanoTarget;
  landed: Landed | null;
  /** This upload created its tour (new-tour), so cancelling early may delete it again. */
  createdTour: boolean;
  machine: UploadState;
  finalize: FinalizeState;
  ctl: UploadController | null;
}

const toActive = (j: Job): ActiveUpload => ({
  key: j.key,
  fileName: j.fileName,
  hasFile: j.file !== null,
  target: j.target,
  machine: j.machine,
  landed: j.landed,
  finalize: j.finalize,
});

const isInFlight = (a: { machine: UploadState; finalize: FinalizeState } | null): boolean => {
  if (!a) return false;
  const p = a.machine.phase;
  if (p === 'preparing' || p === 'upload' || p === 'processing') return true;
  return p === 'ready' && a.finalize.status === 'running';
};

/** The image is in R2 and only server-side work (tiling, then the tour write) is left. */
const isLandedWork = (j: Job): boolean =>
  j.landed !== null &&
  (j.machine.phase === 'processing' ||
    (j.machine.phase === 'ready' && j.finalize.status !== 'done'));

// A file re-picked for a failed or timed-out upload goes over the pano it already landed as.
function retryOver(j: Job | null, target: PanoTarget): string | null {
  const phase = j?.machine.phase;
  if (!j?.landed || (phase !== 'failed' && phase !== 'timed-out')) return null;
  const same =
    target.kind === 'add'
      ? j.target.kind === 'add' && j.target.tourId === target.tourId
      : j.target.kind === 'replace' && j.target.panoId === target.panoId;
  return same ? j.landed.panoId : null;
}

const finalizeFailure = (e: unknown): Extract<FinalizeState, { status: 'failed' }> => {
  if (isAuthError(e)) {
    return { status: 'failed', auth: true, message: 'Sign in again.', retryable: true };
  }
  if (e instanceof FinalizeError) {
    return { status: 'failed', auth: false, message: e.message, retryable: e.retryable };
  }
  return { status: 'failed', auth: false, message: 'Please try again.', retryable: true };
};

/**
 * Owns the uploads: drives each with the web-kit upload machine (its onChange is
 * the chip's only state), finishes it, and resumes it after sign-in.
 */
export function UploadProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const authEnv = useAuthEnv();
  const config = useContext(ConfigContext);
  const uploadEnv = useContext(UploadEnvContext);
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const owner = session.user.sub ?? null;

  const tilesBase = uploadEnv.tilesBase ?? (config ? tilesBaseUrl(config) : null);
  const deps = useMemo<UploadDeps | null>(() => {
    if (!tilesBase) return null;
    return createUploadDeps({
      uploadApi: session.upload,
      adminApi: session.api,
      tilesBase,
      ...(authEnv.fetch && { fetch: authEnv.fetch }),
      ...(uploadEnv.createXhr && { createXhr: uploadEnv.createXhr }),
    });
  }, [tilesBase, session.upload, session.api, authEnv.fetch, uploadEnv.createXhr]);

  const [active, setActive] = useState<ActiveUpload | null>(null);
  // What a sign-in redirect left behind, read once: it decides the first render.
  const [boot] = useState(() => {
    const rec = readResumeRecord();
    if (!rec) return null;
    if (rec.owner !== owner) return { kind: 'foreign' as const, rec };
    // The landing's `?resume=upload` (a new tour) beats a record left for another tour. An
    // image that record already landed still finishes, hidden, so it doesn't block the new one.
    const landing = pathname === '/new' && new URLSearchParams(search).get('resume') === 'upload';
    if (landing && rec.target.kind !== 'new-tour') {
      return rec.landed
        ? { kind: 'poll' as const, rec, hidden: true }
        : { kind: 'stale' as const, rec };
    }
    if (rec.landed && rec.target.kind !== 'new-tour') {
      return { kind: 'poll' as const, rec, hidden: false };
    }
    return { kind: 'repick' as const, rec };
  });
  const bootRepick = boot?.kind === 'repick' ? boot.rec : null;
  // On /app/new the route's own overlay takes the file back instead (one dialog, not two).
  const [picker, setPicker] = useState<{ target: PanoTarget; resume: boolean } | null>(() =>
    bootRepick && bootRepick.target.kind !== 'new-tour' && pathname !== '/new'
      ? { target: bootRepick.target, resume: true }
      : null,
  );
  const [repick, setRepick] = useState<Uploads['repick']>(() =>
    bootRepick
      ? { target: bootRepick.target, fileName: bootRepick.fileName, reason: 'signed-out' }
      : null,
  );
  const [replaced, setReplaced] = useState<Record<string, string>>({});
  const [lastAdded, setLastAdded] = useState<Uploads['lastAdded']>(null);

  const fg = useRef<Job | null>(null);
  const jobs = useRef(new Set<Job>());
  const keyRef = useRef(0);
  const pending = uploadEnv.pending ?? idbPendingUploads;
  const live = useRef({ deps, session, tilesBase, fetch: authEnv.fetch, pending, owner, pathname });
  useEffect(() => {
    live.current = { deps, session, tilesBase, fetch: authEnv.fetch, pending, owner, pathname };
  });

  // One take per page load, shared: a second caller (StrictMode) gets the same answer.
  // The user's own stash only comes back with their matching resume record; without
  // one (the landing's `?resume=upload`), only an unowned landing stash is taken.
  const taken = useRef<Promise<File | null> | null>(null);
  const takePendingFile = useCallback(() => {
    const who = bootRepick ? live.current.owner : null;
    taken.current ??= live.current.pending.take(who).catch(() => null);
    return taken.current;
  }, [bootRepick]);

  /** Mirror a job into the chip if it is the foreground one. */
  const sync = useCallback((j: Job) => {
    if (fg.current === j) setActive(toActive(j));
  }, []);

  /** Make a job the chip's again (a hidden one that now needs the user), if the chip is free. */
  const surface = useCallback(
    (j: Job) => {
      if (fg.current === j) return;
      if (fg.current) {
        jobs.current.delete(j);
        return;
      }
      fg.current = j;
      sync(j);
    },
    [sync],
  );

  /** Survive a sign-in redirect: a record always, the file too if it hadn't landed yet. */
  // Which job's record/stash is saved; a background job finishing must not wipe another's.
  const savedBy = useRef<number | null>(null);
  const persist = useCallback(
    (
      key: number,
      fileName: string,
      target: UploadTarget,
      landed: Landed | null,
      file: File | null,
    ) => {
      const { owner: who, pending: store, session: s } = live.current;
      if (who === null) return;
      savedBy.current = key;
      writeResumeRecord({ owner: who, fileName, target, landed });
      if (!landed && file) s.holdSignIn(store.stash(file, who).catch(() => false));
    },
    [],
  );

  const forget = useCallback(() => {
    savedBy.current = null;
    clearResumeRecord();
    void live.current.pending.clear().catch(() => {});
  }, []);
  /** `forget`, unless another job's record is the one saved. */
  const forgetFor = useCallback(
    (j: Job) => {
      if (savedBy.current === null || savedBy.current === j.key) forget();
    },
    [forget],
  );

  const finalize = useCallback(
    async (j: Job, panoId: string, manifest: Manifest) => {
      j.finalize = { status: 'running' };
      sync(j);
      const { session: s, tilesBase: base, fetch } = live.current;
      try {
        if (j.target.kind === 'replace') {
          // The CDN's max-age=30 copy would otherwise reload the old image.
          if (base) {
            await refreshManifestCache(base, panoId, fetch ? { fetch } : {}).catch(() => {});
          }
          setReplaced((r) => ({ ...r, [panoId]: manifest.version ?? `${Date.now()}` }));
        } else {
          const title = titleFromFileName(j.fileName, 'Untitled pano');
          await addPanoToTour(s.api, j.target.tourId, panoId, title);
          setLastAdded({ tourId: j.target.tourId, panoId });
        }
        forgetFor(j);
        j.finalize = { status: 'done' };
        if (fg.current === j) sync(j);
        else jobs.current.delete(j);
      } catch (e) {
        j.finalize = finalizeFailure(e);
        if (j.finalize.auth) persist(j.key, j.fileName, j.target, j.landed, null);
        else forgetFor(j);
        if (fg.current === j) sync(j);
        else surface(j);
      }
    },
    [sync, surface, persist, forgetFor],
  );

  const onMachine = useCallback(
    (j: Job, s: UploadState) => {
      j.machine = s;
      if (s.phase === 'processing') j.landed = { panoId: s.panoId, mode: s.mode };
      if (s.phase === 'failed' && s.stage === 'auth') {
        const landed = s.resumable && s.panoId ? { panoId: s.panoId, mode: s.resumable } : null;
        persist(j.key, j.fileName, j.target, landed, j.file);
      } else if (s.phase === 'failed' || s.phase === 'timed-out') {
        // Done with, short of a user retry: a reload must not run it again.
        forgetFor(j);
      }
      if (fg.current === j) sync(j);
      else if (s.phase === 'failed' || s.phase === 'timed-out') surface(j);
      else if (s.phase === 'cancelled') jobs.current.delete(j);
      if (s.phase === 'ready') void finalize(j, s.panoId, s.manifest);
    },
    [sync, surface, persist, forgetFor, finalize],
  );

  const run = useCallback(
    (
      file: File | null,
      fileName: string,
      target: PanoTarget,
      source: Source,
      createdTour = false,
      /** Run in the background: the chip (and whatever it shows) is left alone. */
      hidden = false,
    ) => {
      const d = live.current.deps;
      if (!d) throw new Error('Uploads aren’t configured in this build.');
      const prev = fg.current;
      if (prev && !hidden) {
        prev.ctl?.cancel();
        jobs.current.delete(prev);
      }
      const j: Job = {
        key: ++keyRef.current,
        file,
        fileName,
        target,
        landed: 'resume' in source ? source.resume : null,
        createdTour,
        machine: { phase: 'preparing', mode: null },
        finalize: { status: 'idle' },
        ctl: null,
      };
      jobs.current.add(j);
      if (!hidden) {
        fg.current = j;
        setActive(toActive(j));
      }
      const onChange = (s: UploadState) => onMachine(j, s);
      j.ctl =
        'resume' in source
          ? startUpload(d, { ...source, onChange })
          : startUpload(d, { ...source, file: file as File, onChange });
    },
    [onMachine],
  );

  const sourceFor = (target: PanoTarget, landedPanoId: string | null): Source => {
    if (target.kind === 'replace') return { replacePanoId: target.panoId };
    // The image already reached R2 under this panoId: upload over it, don't orphan it.
    return landedPanoId ? { replacePanoId: landedPanoId } : {};
  };

  const begin = useCallback<Uploads['begin']>(
    async (file, target) => {
      if (isInFlight(fg.current)) throw new Error('An upload is already in progress.');
      const { deps: d, session: s } = live.current;
      if (!d) throw new Error('Uploads aren’t configured in this build.');
      let panoTarget: PanoTarget;
      try {
        if (target.kind === 'new-tour') {
          const title = titleFromFileName(file.name, 'Untitled tour');
          const { tourId } = await s.api.createTour({ title, scenes: [] });
          panoTarget = { kind: 'add', tourId };
        } else {
          if (target.kind === 'add') await assertTourHasRoom(s.api, target.tourId);
          panoTarget = target;
        }
      } catch (e) {
        if (isAuthError(e)) persist(-1, file.name, target, null, file);
        throw e;
      }
      forget();
      setRepick(null);
      setPicker(null);
      const over = retryOver(fg.current, panoTarget);
      run(file, file.name, panoTarget, sourceFor(panoTarget, over), target.kind === 'new-tour');
      return { tourId: panoTarget.kind === 'add' ? panoTarget.tourId : null };
    },
    [run, persist, forget],
  );

  // Best effort: a tour this upload created and nothing landed in is removed again.
  const discardEmptyTour = useCallback(
    async (tourId: string) => {
      const { api } = live.current.session;
      try {
        const got = await api.getTour(tourId);
        if (got.status !== 'ok' || got.data.tour.scenes.length > 0) return;
        await api.deleteTour(tourId);
        if (live.current.pathname === `/t/${tourId}`) void navigate('/');
      } catch {
        // Left as an empty tour; the dashboard can delete it.
      }
    },
    [navigate],
  );

  const dismiss = useCallback(() => {
    const j = fg.current;
    fg.current = null;
    setActive(null);
    forget();
    if (!j) return;
    // Hidden, not stopped: tiling and the tour write carry on so the pano doesn't go missing.
    if (isLandedWork(j)) return;
    j.ctl?.cancel();
    jobs.current.delete(j);
    if (!j.landed && j.createdTour && j.target.kind === 'add') {
      void discardEmptyTour(j.target.tourId);
    }
  }, [forget, discardEmptyTour]);

  const onAction = (id: ChipActionId) => {
    const j = fg.current;
    if (!j) return;
    switch (id) {
      case 'retry-poll':
        j.ctl?.retryPoll();
        return;
      case 'retry-upload':
        if (j.file) {
          run(j.file, j.fileName, j.target, sourceFor(j.target, j.landed?.panoId ?? null));
        }
        return;
      case 'retry-finalize':
        if (j.machine.phase === 'ready') void finalize(j, j.machine.panoId, j.machine.manifest);
        return;
      case 'sign-in':
        session.requestSignIn();
        return;
      case 'repick':
        setRepick({ target: j.target, fileName: j.fileName, reason: 'retry' });
        setPicker({ target: j.target, resume: false });
        return;
    }
  };

  // Another user's stash (from a sign-in that never came back) would otherwise sit there.
  useEffect(() => {
    const { owner: who, pending: store } = live.current;
    if (who !== null) void store.dropForeign(who).catch(() => {});
  }, []);

  // After a sign-in redirect: resume polling an image that landed, or get the file back.
  useEffect(() => {
    if (!boot) return;
    const { rec } = boot;
    if (boot.kind === 'foreign' || boot.kind === 'stale') {
      // Someone else's record, or one the landing superseded: drop it.
      clearResumeRecord();
    } else if (boot.kind === 'poll') {
      if (rec.landed && rec.target.kind !== 'new-tour' && live.current.deps) {
        run(null, rec.fileName, rec.target, { resume: rec.landed }, false, boot.hidden);
      }
    } else if (rec.target.kind === 'new-tour' && pathname !== '/new') {
      void navigate('/new?resume=upload');
    }
    // Runs once per mount: the record is the input, not the route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the signed-in tree (sign-out) stops every upload; the record stays for a resume.
  useEffect(() => {
    const all = jobs.current;
    return () => {
      for (const j of all) j.ctl?.cancel();
      all.clear();
      fg.current = null;
    };
  }, []);

  // Background tabs throttle timers to a minute or more: poll as soon as the tab is back.
  useEffect(() => {
    const kick = () => {
      if (document.visibilityState !== 'visible') return;
      for (const j of jobs.current) j.ctl?.pollNow();
    };
    document.addEventListener('visibilitychange', kick);
    window.addEventListener('online', kick);
    return () => {
      document.removeEventListener('visibilitychange', kick);
      window.removeEventListener('online', kick);
    };
  }, []);

  const phase = active?.machine.phase;
  useEffect(() => {
    if (phase !== 'preparing' && phase !== 'upload') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  const model = active ? chipModel(active) : null;
  const tone = model?.tone;
  useEffect(() => {
    if (tone !== 'ready') return;
    const t = setTimeout(() => {
      const j = fg.current;
      if (j) jobs.current.delete(j);
      fg.current = null;
      setActive(null);
    }, READY_CHIP_MS);
    return () => clearTimeout(t);
  }, [tone]);

  const value = useMemo<Uploads>(
    () => ({
      active,
      busy: isInFlight(active),
      begin,
      pick: (target) => setPicker({ target, resume: false }),
      repick,
      clearRepick: () => {
        forget();
        setRepick(null);
      },
      takePendingFile,
      reloadKeyFor: (panoId) => replaced[panoId],
      lastAdded,
    }),
    [active, begin, repick, forget, takePendingFile, replaced, lastAdded],
  );

  const closePicker = () => {
    if (repick) value.clearRepick();
    setPicker(null);
  };

  return (
    <UploadsContext value={value}>
      {children}
      {picker && (
        <UploadOverlay
          target={picker.target}
          {...(repick && picker.resume
            ? { resume: { take: takePendingFile, missingNotice: repickNotice(repick) } }
            : { notice: repick ? repickNotice(repick) : undefined })}
          onClose={closePicker}
        />
      )}
      {model && <UploadChip model={model} onAction={onAction} onDismiss={dismiss} />}
    </UploadsContext>
  );
}
