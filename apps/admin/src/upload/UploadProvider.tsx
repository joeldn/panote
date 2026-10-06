import './upload.css';

import type { StagePreview } from '@internal/ui';
import {
  createUploadDeps,
  decodePreview,
  isAuthError,
  keepPreview,
  probeMaxTextureSize,
  refreshManifestCache,
  replacedVersionOf,
  startUpload,
  tilesBaseUrl,
  type PreviewDecoder,
  type PreviewKeeper,
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
  clearBackgroundRecord,
  clearResumeRecord,
  readBackgroundRecords,
  readResumeRecord,
  writeBackgroundRecord,
  writeResumeRecord,
  type BackgroundRecord,
  type UploadTarget,
} from './resume-store.js';
import {
  idbPendingUploads,
  UploadEnvContext,
  UploadsContext,
  type PanoTarget,
  type PendingUpload,
  type Uploads,
} from './upload-context.js';
import { UploadChip } from './UploadChip.js';
import { UploadOverlay } from './UploadOverlay.js';

/** How long the "ready" chip stays up before it tidies itself away. */
export const READY_CHIP_MS = 8_000;

export const STILL_TILING_MESSAGE =
  'This pano is still processing. You can replace its image once it’s ready.';

// No Worker (jsdom, very old browsers): no preview, and nothing else changes.
const defaultDecode: PreviewDecoder = (file, options) =>
  typeof Worker === 'undefined' ? Promise.resolve(null) : decodePreview(file, options);

type Source = Omit<UploadFileSource, 'file'> | UploadResumeSource;

type Manifest = Extract<UploadState, { phase: 'ready' }>['manifest'];

type Landed = { panoId: string; mode: UploadMode };

/** One upload. The chip shows the foreground job; a hidden one keeps working in the background. */
interface Job {
  key: number;
  file: File | null;
  fileName: string;
  target: PanoTarget;
  /** The pano this upload goes to, once known: the replace target, else the presigned id. */
  panoId: string | null;
  /** Fresh, or replace with its baseline version: known once the baseline is read. */
  mode: UploadMode | null;
  landed: Landed | null;
  /** This upload created its tour (new-tour), so cancelling early may delete it again. */
  createdTour: boolean;
  /** Started in the background; its resume record has its own slot (resume-store's bg). */
  bg: boolean;
  /** Failed while hidden with the chip taken: shown once the chip is free. */
  waiting: boolean;
  machine: UploadState;
  finalize: FinalizeState;
  /** Ready and wrapped up (reload key set, record cleared): no longer pending. */
  done: boolean;
  /** Set while the ready step runs, so it runs once. */
  completing: boolean;
  /** The picked file's local preview; null after a sign-in redirect (no file) or once done. */
  preview: PreviewKeeper | null;
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

/**
 * The image is in R2 and only server-side work (tiling, the tour write, the reload) is
 * left. A failed tour write isn't: nothing retries it unless the user does, so a job
 * dismissed in that state is dropped rather than kept hidden forever.
 */
const isLandedWork = (j: Job): boolean =>
  j.landed !== null &&
  j.finalize.status !== 'failed' &&
  (j.machine.phase === 'processing' || (j.machine.phase === 'ready' && !j.done));

/** Its tiler is (as far as we know) still working: a second replace would race it. */
const isTiling = (j: Job): boolean => j.machine.phase === 'processing';

const jobKey = (j: Job): string => `upload-${j.key}`;

/** An upload's run options beyond its file and target. */
interface RunOptions {
  /** This upload created its tour (new-tour). */
  createdTour?: boolean;
  /** Run in the background: the chip (and whatever it shows) is left alone. */
  bg?: boolean;
  /** A resumed add whose config and tour write already went through. */
  appended?: boolean;
}

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
  // Landed uploads that were finishing in the background before the reload.
  const [bootBg] = useState(readBackgroundRecords);
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
  const [reloadKeys, setReloadKeys] = useState<Record<string, string>>({});
  const [lastAdded, setLastAdded] = useState<Uploads['lastAdded']>(null);
  // Bumped whenever any job changes, hidden ones included: previewFor/pendingFor read jobs.
  const [rev, setRev] = useState(0);
  const touch = useCallback(() => setRev((n) => n + 1), []);

  const fg = useRef<Job | null>(null);
  const jobs = useRef(new Set<Job>());
  const keyRef = useRef(0);
  const pending = uploadEnv.pending ?? idbPendingUploads;
  const live = useRef({
    deps,
    session,
    tilesBase,
    fetch: authEnv.fetch,
    pending,
    owner,
    pathname,
    uploadEnv,
  });
  useEffect(() => {
    live.current = {
      deps,
      session,
      tilesBase,
      fetch: authEnv.fetch,
      pending,
      owner,
      pathname,
      uploadEnv,
    };
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
  const sync = useCallback(
    (j: Job) => {
      if (fg.current === j) setActive(toActive(j));
      touch();
    },
    [touch],
  );

  /** Forget a job for good: it stops counting as pending and its preview is freed. */
  const drop = useCallback(
    (j: Job) => {
      jobs.current.delete(j);
      j.preview?.dispose();
      j.preview = null;
      touch();
    },
    [touch],
  );

  /** Make a job the chip's again (a hidden one that now needs the user), if the chip is free. */
  const surface = useCallback(
    (j: Job) => {
      if (fg.current === j) return;
      if (fg.current) {
        j.waiting = true;
        return;
      }
      fg.current = j;
      sync(j);
    },
    [sync],
  );

  /** The chip is free: show a hidden job that failed meanwhile, if any. */
  const release = useCallback(() => {
    fg.current = null;
    setActive(null);
    const next = [...jobs.current].find((j) => j.waiting);
    if (next) {
      next.waiting = false;
      surface(next);
    }
  }, [surface]);

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
      bg = false,
      appended = false,
    ) => {
      const { owner: who, pending: store, session: s } = live.current;
      if (who === null) return;
      const done = landed && appended ? { appended: true } : {};
      if (bg && landed && target.kind !== 'new-tour') {
        writeBackgroundRecord({ owner: who, fileName, target, landed, ...done });
        return;
      }
      savedBy.current = key;
      writeResumeRecord({ owner: who, fileName, target, landed, ...done });
      if (!landed && file) s.holdSignIn(store.stash(file, who).catch(() => false));
    },
    [],
  );

  const forget = useCallback(() => {
    savedBy.current = null;
    clearResumeRecord();
    void live.current.pending.clear().catch(() => {});
  }, []);
  /** Clear this job's record: its own slot if a background one, else `forget` unless another job's record is the one saved. */
  const forgetFor = useCallback(
    (j: Job) => {
      if (j.bg) {
        if (j.landed) clearBackgroundRecord(j.landed.panoId);
      } else if (savedBy.current === null || savedBy.current === j.key) forget();
    },
    [forget],
  );

  const appendedOf = (j: Job): boolean => j.target.kind === 'add' && j.finalize.status === 'done';

  /**
   * The image is ready: reload whatever shows it. Runs once the scene is in the tour
   * (an added pano) or straight away (a replace, which never touches the tour).
   */
  const complete = useCallback(
    async (j: Job, panoId: string, manifest: Manifest) => {
      // A job dropped meanwhile (cancelled, or superseded by an upload over its pano) must
      // not bump the reload key under whatever runs now.
      if (j.done || j.completing || !jobs.current.has(j)) return;
      // An added pano waits for its tour write; that write calls back here once it's in.
      if (j.target.kind === 'add' && j.finalize.status !== 'done') return;
      j.completing = true;
      if (j.target.kind === 'replace') {
        j.finalize = { status: 'running' };
        sync(j);
      }
      const { tilesBase: base, fetch } = live.current;
      // The CDN's max-age=30 copy would otherwise reload the old image (a replace),
      // and an editor that looked before the tiles existed may hold a 404 (an add).
      if (base) await refreshManifestCache(base, panoId, fetch ? { fetch } : {}).catch(() => {});
      if (!jobs.current.has(j)) return;
      setReloadKeys((r) => ({ ...r, [panoId]: manifest.version ?? `${Date.now()}` }));
      forgetFor(j);
      j.finalize = { status: 'done' };
      j.done = true;
      // The viewer keeps what it was shown until the tiles take over; the rest can go.
      j.preview?.dispose();
      j.preview = null;
      if (fg.current === j) sync(j);
      else drop(j);
    },
    [sync, drop, forgetFor],
  );

  /**
   * An added pano's config (create-only) and tour append, run the moment the image lands
   * so the scene is editable while it tiles. Idempotent: a resume or retry runs it again.
   */
  const append = useCallback(
    async (j: Job) => {
      if (j.target.kind !== 'add' || !j.landed) return;
      if (j.finalize.status === 'running' || j.finalize.status === 'done') return;
      const { tourId } = j.target;
      const { panoId } = j.landed;
      j.finalize = { status: 'running' };
      sync(j);
      try {
        const title = titleFromFileName(j.fileName, 'Untitled pano');
        await addPanoToTour(live.current.session.api, tourId, panoId, title);
        j.finalize = { status: 'done' };
        setLastAdded({ tourId, panoId });
        // A 401 elsewhere (a status poll) may have saved this job's record while the write
        // was out: mark it appended, so the resume doesn't add back a scene removed since.
        if (j.bg) {
          if (readBackgroundRecords().some((r) => r.landed.panoId === panoId)) {
            persist(j.key, j.fileName, j.target, j.landed, null, true, true);
          }
        } else if (savedBy.current === j.key) {
          persist(j.key, j.fileName, j.target, j.landed, null, false, true);
        }
        sync(j);
        if (j.machine.phase === 'ready') await complete(j, j.machine.panoId, j.machine.manifest);
      } catch (e) {
        j.finalize = finalizeFailure(e);
        if (j.finalize.auth) persist(j.key, j.fileName, j.target, j.landed, null, j.bg);
        else forgetFor(j);
        if (fg.current === j) sync(j);
        else if (jobs.current.has(j)) surface(j);
      }
    },
    [sync, surface, persist, forgetFor, complete],
  );

  const onMachine = useCallback(
    (j: Job, s: UploadState) => {
      j.machine = s;
      if ('mode' in s && s.mode) j.mode = s.mode;
      if ('panoId' in s && s.panoId !== null) j.panoId = s.panoId;
      if (s.phase === 'processing') j.landed = { panoId: s.panoId, mode: s.mode };
      if (s.phase === 'failed' && s.stage === 'auth') {
        const landed = s.resumable && s.panoId ? { panoId: s.panoId, mode: s.resumable } : null;
        persist(j.key, j.fileName, j.target, landed, j.file, j.bg, appendedOf(j));
      } else if (s.phase === 'failed' || s.phase === 'timed-out') {
        // Done with, short of a user retry: a reload must not run it again.
        forgetFor(j);
      }
      if (fg.current === j) sync(j);
      else if (s.phase === 'failed' || s.phase === 'timed-out') surface(j);
      else if (s.phase === 'cancelled') drop(j);
      else touch();
      if (s.phase === 'cancelled') {
        j.preview?.dispose();
        j.preview = null;
      }
      // Landed: the scene joins its tour now, while it tiles (an added pano only).
      if (s.phase === 'processing' && j.finalize.status === 'idle') void append(j);
      if (s.phase === 'ready') void complete(j, s.panoId, s.manifest);
    },
    [sync, surface, persist, forgetFor, drop, touch, append, complete],
  );

  const run = useCallback(
    (
      file: File | null,
      fileName: string,
      target: PanoTarget,
      source: Source,
      opts: RunOptions = {},
    ) => {
      const { createdTour = false, bg = false, appended = false } = opts;
      const d = live.current.deps;
      if (!d) throw new Error('Uploads aren’t configured in this build.');
      const resume = 'resume' in source ? source.resume : null;
      const panoId =
        resume?.panoId ?? ('replacePanoId' in source ? (source.replacePanoId ?? null) : null);
      const prev = fg.current;
      // The same file again (Try again): its preview carries over rather than decoding twice.
      let preview: PreviewKeeper | null = null;
      if (prev && !bg && file && prev.file === file && prev.preview) {
        preview = prev.preview;
        prev.preview = null;
      }
      if (prev && !bg) {
        prev.ctl?.cancel();
        drop(prev);
      }
      // One machine per pano: a hidden one still watching it (timed out, say) would take
      // this upload's tiles for its own.
      if (panoId !== null && !resume) {
        for (const o of jobs.current) {
          if (o.panoId !== panoId) continue;
          o.ctl?.cancel();
          drop(o);
        }
      }
      const j: Job = {
        key: ++keyRef.current,
        file,
        fileName,
        target,
        panoId,
        mode: resume?.mode ?? null,
        landed: resume,
        createdTour,
        bg,
        waiting: false,
        machine: { phase: 'preparing', mode: null },
        finalize:
          resume && appended && target.kind === 'add' ? { status: 'done' } : { status: 'idle' },
        done: false,
        completing: false,
        preview,
        ctl: null,
      };
      jobs.current.add(j);
      if (!bg) {
        fg.current = j;
        setActive(toActive(j));
      }
      if (file && !preview) {
        const { uploadEnv: env } = live.current;
        const keeper = keepPreview(file, {
          decode: env.decodePreview ?? defaultDecode,
          maxTextureSize: env.maxTextureSize ?? probeMaxTextureSize(),
        });
        j.preview = keeper;
        void keeper.ready.then((ok) => {
          // Whichever job holds it now: Try again may have carried it over to a new one.
          const owner = ok ? [...jobs.current].find((o) => o.preview === keeper) : undefined;
          if (!owner) return;
          // Full-size bitmaps stay up for the newest preview only; older ones re-decode their stash.
          for (const o of jobs.current) if (o !== owner) o.preview?.release();
          touch();
        });
      }
      const onChange = (s: UploadState) => onMachine(j, s);
      j.ctl =
        'resume' in source
          ? startUpload(d, { ...source, onChange })
          : startUpload(d, { ...source, file: file as File, onChange });
      touch();
    },
    [onMachine, drop, touch],
  );

  const sourceFor = (target: PanoTarget, landedPanoId: string | null): Source => {
    if (target.kind === 'replace') return { replacePanoId: target.panoId };
    // The image already reached R2 under this panoId: upload over it, don't orphan it.
    return landedPanoId ? { replacePanoId: landedPanoId } : {};
  };

  const begin = useCallback<Uploads['begin']>(
    async (file, target) => {
      if (isInFlight(fg.current)) throw new Error('An upload is already in progress.');
      // Its tiler would race this one's, and the baseline (so the preview and the
      // readiness check) would be the first upload's tiles. Timed-out jobs don't count:
      // re-uploading over a stuck pano is the way out, and run() stops watching it.
      if (target.kind === 'replace') {
        const panoId = target.panoId;
        if ([...jobs.current].some((j) => j.panoId === panoId && isTiling(j))) {
          throw new Error(STILL_TILING_MESSAGE);
        }
      }
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
      run(file, file.name, panoTarget, sourceFor(panoTarget, over), {
        createdTour: target.kind === 'new-tour',
      });
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
    release();
    // Only this job's record: a waiting job release() just showed may have saved its own.
    // A tour write that needs a sign-in keeps it, so the next sign-in still adds the pano.
    const needsSignIn = j?.finalize.status === 'failed' && j.finalize.auth;
    if (j && !needsSignIn) forgetFor(j);
    else if (!j) forget();
    if (!j) return;
    // Hidden, not stopped: tiling and the tour write carry on so the pano doesn't go missing.
    if (isLandedWork(j)) return;
    j.ctl?.cancel();
    drop(j);
    if (!j.landed && j.createdTour && j.target.kind === 'add') {
      void discardEmptyTour(j.target.tourId);
    }
  }, [release, forget, forgetFor, discardEmptyTour, drop]);

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
        if (j.target.kind === 'add') void append(j);
        else if (j.machine.phase === 'ready')
          void complete(j, j.machine.panoId, j.machine.manifest);
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
    const background = (r: BackgroundRecord) => {
      if (r.target.kind !== 'new-tour' && live.current.deps) {
        run(null, r.fileName, r.target, { resume: r.landed }, { bg: true, appended: !!r.appended });
      }
    };
    for (const r of bootBg) {
      if (r.owner === owner) background(r);
      else clearBackgroundRecord(r.landed.panoId);
    }
    if (!boot) return;
    const { rec } = boot;
    if (boot.kind === 'foreign' || boot.kind === 'stale') {
      // Someone else's record, or one the landing superseded: drop it.
      clearResumeRecord();
    } else if (boot.kind === 'poll' && boot.hidden && rec.landed) {
      // Moved to its own slot so the landing upload's record can't overwrite or clear it.
      const moved = { ...rec, landed: rec.landed };
      writeBackgroundRecord(moved);
      clearResumeRecord();
      background(moved);
    } else if (boot.kind === 'poll') {
      if (rec.landed && rec.target.kind !== 'new-tour' && live.current.deps) {
        run(null, rec.fileName, rec.target, { resume: rec.landed }, { appended: !!rec.appended });
        // The record is this job's: its append marks it, and only it clears it.
        savedBy.current = keyRef.current;
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
      for (const j of all) {
        j.ctl?.cancel();
        j.preview?.dispose();
      }
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

  // Closing the tab mid PUT loses the upload; mid tour write (any job, hidden ones too)
  // it leaves the landed pano out of its tour.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      const phase = fg.current?.machine.phase;
      const appending = [...jobs.current].some(
        (j) => j.target.kind === 'add' && j.finalize.status === 'running',
      );
      if (phase === 'preparing' || phase === 'upload' || appending) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const model = active ? chipModel(active) : null;
  const tone = model?.tone;
  useEffect(() => {
    if (tone !== 'ready') return;
    const t = setTimeout(() => {
      const j = fg.current;
      if (j) drop(j);
      release();
    }, READY_CHIP_MS);
    return () => clearTimeout(t);
  }, [tone, release, drop]);

  const value = useMemo<Uploads>(() => {
    // Newest first: a retry's job supersedes the one it replaced.
    const current = () => [...jobs.current].reverse().filter((j) => !j.done);
    const previewFor = (panoId: string): StagePreview | null => {
      const j = current().find((x) => x.panoId === panoId && x.machine.phase !== 'cancelled');
      const keeper = j?.preview;
      // A replace's preview waits for its baseline: without it the viewer can't tell
      // the old tiles from the new ones.
      if (!j?.mode || !keeper?.available) return null;
      const replaces = replacedVersionOf(j.mode);
      return {
        panoId,
        key: jobKey(j),
        source: () => keeper.next(),
        ...(replaces !== undefined && { replacesVersion: replaces }),
      };
    };
    const pendingFor = (tourId: string): PendingUpload[] =>
      current()
        .reverse()
        .filter((j) => j.target.tourId === tourId && j.machine.phase !== 'cancelled')
        .map((j) => ({
          key: jobKey(j),
          target: j.target,
          fileName: j.fileName,
          panoId: j.panoId,
          machine: j.machine,
          finalize: j.finalize,
          hasPreview: j.preview?.available ?? false,
        }));
    return {
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
      reloadKeyFor: (panoId) => reloadKeys[panoId],
      lastAdded,
      previewFor,
      pendingFor,
    };
    // rev: the jobs behind previewFor and pendingFor changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, begin, repick, forget, takePendingFile, reloadKeys, lastAdded, rev]);

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
