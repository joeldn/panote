import './upload.css';

import {
  createUploadDeps,
  initialUploadState,
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

import { chipModel, type ActiveUpload, type ChipActionId } from './chip-model.js';
import { addPanoToTour, titleFromFileName } from './finalize.js';
import { repickNotice } from './repick-notice.js';
import { clearResumeRecord, readResumeRecord, writeResumeRecord } from './resume-store.js';
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

const isInFlight = (a: ActiveUpload | null): boolean => {
  if (!a) return false;
  const p = a.machine.phase;
  if (p === 'preparing' || p === 'upload' || p === 'processing') return true;
  return p === 'ready' && a.finalize.status === 'running';
};

// A file re-picked for a failed or timed-out upload goes over the pano it already landed as.
function retryOver(
  c: { target: PanoTarget; landed: { panoId: string } | null } | null,
  phase: UploadState['phase'] | undefined,
  target: PanoTarget,
): string | null {
  if (!c?.landed || (phase !== 'failed' && phase !== 'timed-out')) return null;
  const same =
    target.kind === 'add'
      ? c.target.kind === 'add' && c.target.tourId === target.tourId
      : c.target.kind === 'replace' && c.target.panoId === target.panoId;
  return same ? c.landed.panoId : null;
}

const messageOf = (e: unknown): string =>
  e instanceof Error && e.name === 'FinalizeError' ? e.message : 'Please try again.';

/**
 * Owns the one upload at a time: drives it with the web-kit upload machine (its
 * onChange is the chip's only state), finishes it, and resumes it after sign-in.
 */
export function UploadProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const authEnv = useAuthEnv();
  const config = useContext(ConfigContext);
  const uploadEnv = useContext(UploadEnvContext);
  const navigate = useNavigate();
  const { pathname } = useLocation();

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
  const [picker, setPicker] = useState<{ target: PanoTarget; resume: boolean } | null>(null);
  const [repick, setRepick] = useState<Uploads['repick']>(null);
  const [replaced, setReplaced] = useState<Record<string, string>>({});
  const [lastAdded, setLastAdded] = useState<Uploads['lastAdded']>(null);

  const ctl = useRef<UploadController | null>(null);
  const keyRef = useRef(0);
  // What callbacks of the current upload need; `active` state lags a render behind.
  const cur = useRef<{
    key: number;
    file: File | null;
    fileName: string;
    target: PanoTarget;
    landed: { panoId: string; mode: UploadMode } | null;
  } | null>(null);
  const pending = uploadEnv.pending ?? idbPendingUploads;
  const live = useRef({ deps, session, tilesBase, fetch: authEnv.fetch, pending });
  useEffect(() => {
    live.current = { deps, session, tilesBase, fetch: authEnv.fetch, pending };
  });
  // One take per page load, shared: a second caller (StrictMode) gets the same answer.
  const taken = useRef<Promise<File | null> | null>(null);
  const takePendingFile = useCallback(() => {
    taken.current ??= live.current.pending.take().catch(() => null);
    return taken.current;
  }, []);

  const update = useCallback((key: number, fn: (a: ActiveUpload) => ActiveUpload) => {
    setActive((a) => (a && a.key === key ? fn(a) : a));
  }, []);

  const finalize = useCallback(
    async (key: number, panoId: string, manifest: Manifest) => {
      const c = cur.current;
      if (!c || c.key !== key) return;
      update(key, (a) => ({ ...a, finalize: { status: 'running' } }));
      const { session: s, tilesBase: base, fetch } = live.current;
      try {
        if (c.target.kind === 'replace') {
          // The CDN's max-age=30 copy would otherwise reload the old image.
          if (base)
            await refreshManifestCache(base, panoId, fetch ? { fetch } : {}).catch(() => {});
          setReplaced((r) => ({ ...r, [panoId]: manifest.version ?? `${Date.now()}` }));
        } else {
          const title = titleFromFileName(c.fileName, 'Untitled pano');
          await addPanoToTour(s.api, c.target.tourId, panoId, title);
          setLastAdded({ tourId: c.target.tourId, panoId });
        }
        if (cur.current?.key !== key) return;
        clearResumeRecord();
        update(key, (a) => ({ ...a, finalize: { status: 'done' } }));
      } catch (e) {
        if (cur.current?.key !== key) return;
        const auth = isAuthError(e);
        if (auth) writeResumeRecord({ fileName: c.fileName, target: c.target, landed: c.landed });
        update(key, (a) => ({
          ...a,
          finalize: { status: 'failed', auth, message: messageOf(e) },
        }));
      }
    },
    [update],
  );

  const onMachine = useCallback(
    (key: number, s: UploadState) => {
      const c = cur.current;
      if (!c || c.key !== key) return;
      if (s.phase === 'processing') c.landed = { panoId: s.panoId, mode: s.mode };
      if (s.phase === 'failed' && s.stage === 'auth') {
        const landed = s.resumable && s.panoId ? { panoId: s.panoId, mode: s.resumable } : null;
        writeResumeRecord({ fileName: c.fileName, target: c.target, landed });
        // Not landed yet: the file itself has to wait out the redirect.
        if (!landed && c.file) void live.current.pending.stash(c.file).catch(() => false);
      }
      update(key, (a) => ({ ...a, machine: s, landed: c.landed }));
      if (s.phase === 'ready') void finalize(key, s.panoId, s.manifest);
    },
    [update, finalize],
  );

  const run = useCallback(
    (file: File | null, fileName: string, target: PanoTarget, source: Source) => {
      const d = live.current.deps;
      if (!d) throw new Error('Uploads aren’t configured in this build.');
      ctl.current?.cancel();
      const key = ++keyRef.current;
      const landed = 'resume' in source ? source.resume : null;
      cur.current = { key, file, fileName, target, landed };
      setActive({
        key,
        fileName,
        hasFile: file !== null,
        target,
        machine: initialUploadState(),
        landed,
        finalize: { status: 'idle' },
      });
      const onChange = (s: UploadState) => onMachine(key, s);
      ctl.current =
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
      if (isInFlight(active)) throw new Error('An upload is already in progress.');
      if (!live.current.deps) throw new Error('Uploads aren’t configured in this build.');
      let panoTarget: PanoTarget;
      if (target.kind === 'new-tour') {
        try {
          const title = titleFromFileName(file.name, 'Untitled tour');
          const { tourId } = await live.current.session.api.createTour({ title, scenes: [] });
          panoTarget = { kind: 'add', tourId };
        } catch (e) {
          if (isAuthError(e)) {
            writeResumeRecord({ fileName: file.name, target, landed: null });
            void live.current.pending.stash(file).catch(() => false);
          }
          throw e;
        }
      } else {
        panoTarget = target;
      }
      clearResumeRecord();
      setRepick(null);
      setPicker(null);
      run(
        file,
        file.name,
        panoTarget,
        sourceFor(panoTarget, retryOver(cur.current, active?.machine.phase, panoTarget)),
      );
      return { tourId: panoTarget.kind === 'add' ? panoTarget.tourId : null };
    },
    [active, run],
  );

  const dismiss = useCallback(() => {
    ctl.current?.cancel();
    ctl.current = null;
    cur.current = null;
    clearResumeRecord();
    setActive(null);
  }, []);

  const onAction = (id: ChipActionId) => {
    const c = cur.current;
    if (!c || !active) return;
    switch (id) {
      case 'retry-poll':
        ctl.current?.retryPoll();
        return;
      case 'retry-upload':
        if (c.file)
          run(c.file, c.fileName, c.target, sourceFor(c.target, c.landed?.panoId ?? null));
        return;
      case 'retry-finalize':
        if (active.machine.phase === 'ready') {
          void finalize(c.key, active.machine.panoId, active.machine.manifest);
        }
        return;
      case 'sign-in':
        session.requestSignIn();
        return;
      case 'repick':
        setRepick({ target: c.target, fileName: c.fileName, reason: 'retry' });
        setPicker({ target: c.target, resume: false });
        return;
    }
  };

  // After a sign-in redirect: resume polling an image that landed, or ask for the file again.
  useEffect(() => {
    const rec = readResumeRecord();
    if (!rec) return;
    if (rec.landed && rec.target.kind !== 'new-tour' && live.current.deps) {
      run(null, rec.fileName, rec.target, { resume: rec.landed });
      return;
    }
    setRepick({ target: rec.target, fileName: rec.fileName, reason: 'signed-out' });
    if (rec.target.kind !== 'new-tour') setPicker({ target: rec.target, resume: true });
    else if (pathname !== '/new') void navigate('/new?resume=upload');
    // Runs once per mount: the record is the input, not the route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the signed-in tree (sign-out) stops the upload; the record stays for a resume.
  useEffect(
    () => () => {
      ctl.current?.cancel();
      ctl.current = null;
    },
    [],
  );

  // Background tabs throttle timers to a minute or more: poll as soon as the tab is back.
  useEffect(() => {
    const kick = () => {
      if (document.visibilityState === 'visible') ctl.current?.pollNow();
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
    const t = setTimeout(
      () => setActive((a) => (a?.key === cur.current?.key ? null : a)),
      READY_CHIP_MS,
    );
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
        clearResumeRecord();
        setRepick(null);
      },
      takePendingFile,
      reloadKeyFor: (panoId) => replaced[panoId],
      lastAdded,
    }),
    [active, begin, repick, takePendingFile, replaced, lastAdded],
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
