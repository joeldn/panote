import {
  DEFAULT_TOUR_SETTINGS,
  languageName,
  localizeHotspot,
  MAX_SCENE_TRANSLATION_CHARS,
  planKey,
  sceneTranslationChars,
  type Hotspot,
} from '@internal/contracts';
import {
  Button,
  Compass,
  ConfirmModal,
  FloorLinks,
  HotspotMarkers,
  LogoMark,
  PanoStage,
  pointIcon,
  ViewerControls,
  type ViewerHotspot,
  type ViewerLinkArrow,
} from '@internal/ui';
import { MAX_TOUR_SCENES, tilesBaseUrl } from '@internal/web-kit';
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet, useBlocker, useParams, useSearchParams } from 'react-router';

import './editor.css';

import { useAuthEnv } from '../auth-context.js';
import { useConfig } from '../config-context.js';
import { writeCurrentTour } from '../dashboard/current-tour.js';
import { OwnerAccountMenu } from '../account/OwnerAccountMenu.js';
import { useSession } from '../session.js';
import type { ShareOutletContext } from '../share/ShareRoute.js';
import { UploadEnvContext, useUploads } from '../upload/upload-context.js';
import { ConflictBanner, ErrorBanner, Notices } from './Banners.js';
import { InlineText } from './InlineText.js';
import { FALLBACK_LANGUAGE, LanguageMenu } from './LanguageMenu.js';
import { LibraryPicker } from './LibraryPicker.js';
import { MapPanel } from './MapPanel.js';
import { newId, pointSizeForDrag, yawDegrees, type ConfigState, type EditorDocs } from './model.js';
import { PointEditor } from './PointEditor.js';
import { PlanImageError, preparePlanImage, uploadPlanImage } from './plan-image.js';
import { PointerLayer, type LayerPoint } from './PointerLayer.js';
import {
  isLanding,
  isLookOnly,
  isPendingCard,
  pendingLine,
  pendingProblem,
  sceneStatusOf,
  tilingOf,
  tilingOfJob,
  type SceneStatus,
} from './scene-status.js';
import { SettingsPopover } from './SettingsPopover.js';
import { StageFactoryContext, type Viewer } from './stage-factory.js';
import { StageStatus } from './StageStatus.js';
import { SceneDescription } from './SceneDescription.js';
import { TourPanel } from './TourPanel.js';
import { replaceImagePath } from './upload-links.js';
import { useEditor, type EditorController } from './use-editor.js';
import { useTilingWatch } from './use-tiling-watch.js';

const FOV_MIN = 15;
const FOV_MAX = 80;

type Confirm =
  | { kind: 'remove-pano'; panoId: string }
  | { kind: 'delete-point'; panoId: string; id: string; title: string }
  | { kind: 'remove-language'; lang: string };

/** A point being moved, and where it was, for Esc to put it back. */
interface Moving {
  panoId: string;
  id: string;
  yaw: number;
  pitch: number;
}

const toViewerHotspot = (h: Hotspot): ViewerHotspot => {
  const v: ViewerHotspot = { id: h.id, yaw: h.yaw, pitch: h.pitch, title: h.title };
  if (h.icon !== undefined) v.icon = h.icon;
  if (h.size !== undefined) v.size = h.size;
  return v;
};

/** Route element for `/app/t/:tourId` (screens 04 and 13). */
export function Editor() {
  const { tourId = '' } = useParams();
  // Keyed so moving to another tour starts from a fresh editor (no state carried across).
  return <TourEditor key={tourId} tourId={tourId} />;
}

function TourEditor({ tourId }: { tourId: string }) {
  const { api, user } = useSession();
  const editor = useEditor(api, tourId, user.sub ?? 'anonymous');
  const { load } = editor;
  const ready = load.status === 'ready';
  useEffect(() => {
    if (ready) writeCurrentTour(tourId);
  }, [ready, tourId]);

  // A pano the upload chip appended to this tour since it opened: fold it in.
  const { lastAdded } = useUploads();
  const seenAdded = useRef(lastAdded);
  const { syncAppended } = editor;
  useEffect(() => {
    if (!ready || !lastAdded || lastAdded === seenAdded.current) return;
    seenAdded.current = lastAdded;
    if (lastAdded.tourId === tourId) void syncAppended();
  }, [ready, lastAdded, tourId, syncAppended]);

  if (load.status === 'loading') {
    return <EditorMessage title="Loading tour…" />;
  }
  if (load.status === 'not-found') {
    return (
      <EditorMessage title="Tour not found">
        <p>
          It may have been deleted. <Link to="/">Back to your tours</Link>
        </p>
      </EditorMessage>
    );
  }
  if (load.status === 'error' || !editor.docs) {
    return (
      <EditorMessage title="Couldn’t load this tour">
        <p>
          {load.status === 'error' ? load.message : ''}{' '}
          <button type="button" onClick={editor.retryLoad}>
            Try again
          </button>
        </p>
      </EditorMessage>
    );
  }
  return <EditorScreen editor={editor} docs={editor.docs} />;
}

function EditorMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="app-shell__main">
      <section className="placeholder" role={children ? 'alert' : 'status'}>
        <h1>{title}</h1>
        {children}
      </section>
    </main>
  );
}

// The tab-close prompt lives in useEditor (the re-auth redirect has to disarm it).
function useUnsavedGuards(dirty: boolean, tourId: string) {
  // Share and insights open over the editor; anything else unmounts it.
  const inside = new RegExp(`/t/${tourId}(/(share/[a-z]+|insights))?/?$`);
  return useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      currentLocation.pathname !== nextLocation.pathname &&
      !inside.test(nextLocation.pathname),
  );
}

function SaveButton({ editor }: { editor: EditorController }) {
  const { saving, dirty, conflicts, savedAt } = editor;
  if (saving) {
    return (
      <Button variant="glass" pill busy>
        Saving…
      </Button>
    );
  }
  if (conflicts.length > 0) {
    // Resolved from the conflict banner (reload or overwrite), never by a blind re-save.
    return (
      <span className="ed-saved ed-saved--conflict" role="status">
        <i className="fa-solid fa-code-merge" aria-hidden="true" /> Conflict
      </span>
    );
  }
  if (dirty.length > 0) {
    // A live tour's Save also updates what its link shows: say so where the click happens.
    const live = editor.publish !== null;
    return (
      <>
        {live && (
          <span id="ed-save-hint" className="ed-save-hint">
            Saving updates the live link
          </span>
        )}
        <Button
          variant="primary"
          pill
          onClick={() => void editor.save()}
          aria-keyshortcuts="Control+S Meta+S"
          aria-describedby={live ? 'ed-save-hint' : undefined}
        >
          Save
        </Button>
      </>
    );
  }
  return (
    <span
      className="ed-saved"
      role="status"
      title={savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : undefined}
    >
      <i className="fa-solid fa-circle-check" aria-hidden="true" /> Saved
    </span>
  );
}

function EditorScreen({ editor, docs }: { editor: EditorController; docs: EditorDocs }) {
  const config = useConfig();
  const session = useSession();
  const uploads = useUploads();
  const { fetch: authFetch } = useAuthEnv();
  const createViewer = useContext(StageFactoryContext);
  const [params, setParams] = useSearchParams();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [activePoint, setActivePoint] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [moving, setMoving] = useState<Moving | null>(null);
  // A point dropped by a placing drag that is still sizing it (Esc takes it back out).
  const sizing = useRef<{ panoId: string; id: string; size: number | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [languagesOpen, setLanguagesOpen] = useState(false);
  // The language titles and text are edited in; null is the default language.
  const [editLang, setEditLang] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const uploadEnv = useContext(UploadEnvContext);
  const [planUploading, setPlanUploading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  // The share modal opens over the editor: sharing it starts or stops is the editor's too.
  // It may not publish what a running or half-failed Save left on the server either.
  const { setShared, publishBlocked } = editor;
  const shareContext = useMemo<ShareOutletContext>(
    () => ({ onSharingChange: setShared, publishBlocked }),
    [setShared, publishBlocked],
  );
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [failedLoad, setFailedLoad] = useState<string | null>(null);
  const frame = useRef<HTMLElement>(null);
  const { dispatch, dirty } = editor;
  const tour = docs.tour.current;
  const settings = tour.settings ?? DEFAULT_TOUR_SETTINGS;
  const defaultLang = tour.languages?.default ?? FALLBACK_LANGUAGE;
  // Only a language the tour still has: one removed (or reloaded away) drops back.
  const lang = editLang && tour.languages?.others.includes(editLang) ? editLang : null;
  const translation = lang ? { lang, name: languageName(lang) } : null;
  // What a field shows while translating: its translation, with the default text behind it.
  const tr = <F extends string>(
    base: string | undefined,
    i18n: Partial<Record<string, Partial<Record<F, string | undefined>> | undefined>> | undefined,
    field: F,
  ) => (lang ? { value: i18n?.[lang]?.[field] ?? '', placeholder: base ?? '' } : null);
  const blocker = useUnsavedGuards(dirty.length > 0, docs.tourId);

  const sceneIds = useMemo(() => tour.scenes.map((s) => s.panoId), [tour.scenes]);
  const startId = tour.startPanoId && sceneIds.includes(tour.startPanoId) ? tour.startPanoId : null;
  // Uploads into this tour, and the ones that have no scene yet (the pending cards).
  const jobs = uploads.pendingFor(docs.tourId);
  const pendingCards = jobs.filter((p) => isPendingCard(p, sceneIds));
  // Plus the ones already in the server's tour that this editor hasn't synced in yet.
  const knownIds = Object.keys(docs.scenes);
  const staged = [...pendingCards, ...jobs.filter((p) => isLanding(p, sceneIds, knownIds))];
  const pendingIds = staged.flatMap((p) => (p.panoId ? [p.panoId] : []));
  const requested = params.get('pano');
  const currentId =
    requested && (sceneIds.includes(requested) || pendingIds.includes(requested))
      ? requested
      : (startId ?? sceneIds[0] ?? null);
  const scene = currentId ? docs.scenes[currentId] : undefined;
  const sceneConfig: ConfigState | null = scene?.kind === 'config' ? scene : null;
  const cfg = sceneConfig?.current ?? null;
  // An upload on stage before it has a scene: its local preview, look-only.
  const pendingCurrent =
    currentId && !scene ? (staged.find((p) => p.panoId === currentId) ?? null) : null;

  // Scenes whose tiles the editor checks on itself: ones whose tiles failed to load on
  // stage, and the ones the last publish waited on, unless an upload here speaks for them.
  const [stageMisses, setStageMisses] = useState<string[]>([]);
  const liveJob = (panoId: string) =>
    jobs.some((p) => p.panoId === panoId && tilingOfJob(p) !== 'unknown');
  const watchTargets = [...new Set([...stageMisses, ...(editor.awaitingTiles ?? [])])].filter(
    (id) => sceneIds.includes(id) && !liveJob(id) && uploads.reloadKeyFor(id) === undefined,
  );
  const watch = useTilingWatch({
    api: session.api,
    targets: watchTargets,
    tilesBase: tilesBaseUrl(config),
    fetch: authFetch,
  });
  const tilingFor = (panoId: string) =>
    tilingOf(panoId, jobs, watch.polled[panoId], uploads.reloadKeyFor(panoId) !== undefined);
  const statusFor = (panoId: string): SceneStatus | null => sceneStatusOf(tilingFor(panoId));
  // An upload in this tab now speaks for a pano the editor was polling (a Replace, say).
  const liveIds = jobs.flatMap((p) => (p.panoId && tilingOfJob(p) !== 'unknown' ? [p.panoId] : []));
  const { forget } = watch;
  const liveKey = liveIds.join('\n');
  useEffect(() => {
    for (const id of liveKey ? liveKey.split('\n') : []) forget(id);
  }, [liveKey, forget]);

  // A timed-out pano still being checked on its own needs no Check again.
  const checkingOn = (panoId: string): boolean => {
    const job = jobs.findLast((p) => p.panoId === panoId);
    if (job?.machine.phase === 'timed-out') return job.machine.checking;
    const p = watch.polled[panoId];
    return p?.state === 'timed-out' && p.checking;
  };

  const currentStatus: SceneStatus | null = pendingCurrent
    ? 'uploading'
    : currentId && scene
      ? statusFor(currentId)
      : null;
  const lookOnly = pendingCurrent !== null || isLookOnly(currentStatus);

  const reloadKey = currentId
    ? [uploads.reloadKeyFor(currentId), watch.reloadKeys[currentId]].filter(Boolean).join('+')
    : '';
  // A scene joins the tour as soon as its image lands, so its tiles may not exist yet:
  // the note is for this pano at this reload key, and the reload once they're ready clears it.
  const loadKey = `${currentId ?? ''}\n${reloadKey}`;

  // The last publish waited on these panos' tiles: publish again once they're all in,
  // or stop waiting (and say so) if one of them failed.
  const { awaitingTiles, autoRepublish, tilesFailed, saving, publishing } = editor;
  const awaitedKey = (awaitingTiles ?? []).map((id) => `${id}=${tilingFor(id)}`).join('\n');
  useEffect(() => {
    if (!awaitedKey || saving || publishing) return;
    const awaited = awaitedKey.split('\n').map((row) => row.split('='));
    const failed = awaited.filter(([, t]) => t === 'failed').map(([id]) => id!);
    if (failed.length > 0) tilesFailed(failed);
    else if (awaited.every(([, t]) => t === 'ready')) void autoRepublish();
  }, [awaitedKey, saving, publishing, tilesFailed, autoRepublish]);

  // A new upload into this tour goes on stage the moment it has a pano id, so its local
  // preview shows while it uploads. Once per upload: the user can look elsewhere after.
  const shownUploads = useRef(new Set<string>());
  const uploading = pendingCards
    .filter((p) => p.machine.phase === 'preparing' || p.machine.phase === 'upload')
    .flatMap((p) => (p.panoId ? [`${p.key}=${p.panoId}`] : []))
    .join('\n');
  useEffect(() => {
    for (const row of uploading ? uploading.split('\n') : []) {
      const [key, panoId] = row.split('=') as [string, string];
      if (shownUploads.current.has(key)) continue;
      shownUploads.current.add(key);
      setParams({ pano: panoId }, { replace: true });
    }
  }, [uploading, setParams]);

  // A move belongs to the open point: opening another (or none) ends it where it is.
  const openPoint = (id: string | null) => {
    setActivePoint(id);
    setMoving(null);
  };

  const select = (panoId: string) => {
    openPoint(null);
    setPlacing(false);
    setFailedLoad(null);
    setParams({ pano: panoId }, { replace: true });
  };

  // Look-only: nothing can be placed or edited on this scene (see `point` below).
  const placingNow = placing && !lookOnly;
  // Memoised: the stage's markers and chevrons re-place themselves whenever
  // these arrays change, so a new one on every editor render would do it on
  // every keystroke.
  const points = useMemo(() => (cfg ? cfg.hotspots.filter((h) => h.type === 'info') : []), [cfg]);
  const markers = useMemo(
    () => points.map((h) => toViewerHotspot(localizeHotspot(h, lang))),
    [points, lang],
  );
  const point = lookOnly ? null : (points.find((h) => h.id === activePoint) ?? null);
  const movingNow =
    moving && point?.id === moving.id && moving.panoId === currentId ? moving : null;
  const links = useMemo<ViewerLinkArrow[]>(
    () =>
      cfg
        ? cfg.hotspots.flatMap((h) => {
            const target = h.targetPanoId ? docs.scenes[h.targetPanoId] : undefined;
            if (h.type !== 'link' || !h.targetPanoId || !sceneIds.includes(h.targetPanoId)) {
              return [];
            }
            // Not this scene itself (cfg is the scene on stage's config).
            if (target?.kind !== 'config' || target.current === cfg) return [];
            return [{ to: h.targetPanoId, yaw: h.yaw, label: target.current.title }];
          })
        : [],
    [cfg, docs.scenes, sceneIds],
  );

  const view = () => viewer?.getView();
  const direction = (at: LayerPoint) => {
    if (!viewer) return null;
    const { yaw, pitch } = viewer.directionAtPixel(at.x, at.y);
    return { yaw, pitch };
  };
  const drop = (at: LayerPoint): string | null => {
    const dir = direction(at);
    if (!dir || !currentId || lookOnly) return null;
    const id = newId('pt');
    dispatch({
      type: 'point/add',
      panoId: currentId,
      hotspot: { id, type: 'info', ...dir, title: 'New point' },
    });
    return id;
  };
  const placed = (id: string | null) => {
    setPlacing(false);
    if (id) openPoint(id);
  };
  // Dragging out from the drop spot sizes the new point: its marker's edge follows the pointer.
  const sizeDrag = (at: LayerPoint, start: LayerPoint) => {
    if (!currentId) return;
    if (!sizing.current) {
      const id = drop(start);
      if (!id) return;
      sizing.current = { panoId: currentId, id, size: null };
    }
    const size = pointSizeForDrag(Math.hypot(at.x - start.x, at.y - start.y));
    if (size === sizing.current.size) return;
    sizing.current.size = size;
    const { panoId, id } = sizing.current;
    dispatch({ type: 'point/update', panoId, id, patch: { size } });
  };
  const moveTo = (at: LayerPoint) => {
    const dir = direction(at);
    if (!dir || !movingNow) return;
    if (dir.yaw === point?.yaw && dir.pitch === point.pitch) return;
    dispatch({ type: 'point/update', panoId: movingNow.panoId, id: movingNow.id, patch: dir });
  };

  // Esc, or a drag the browser cancelled: a point a placing drag dropped goes back out,
  // and a point being moved goes back where it was.
  const cancelPlacing = () => {
    setPlacing(false);
    if (!sizing.current) return;
    dispatch({ type: 'point/remove', panoId: sizing.current.panoId, id: sizing.current.id });
    sizing.current = null;
  };
  const cancelMove = () => {
    if (!movingNow) return;
    const { panoId, id, yaw, pitch } = movingNow;
    dispatch({ type: 'point/update', panoId, id, patch: { yaw, pitch } });
    setMoving(null);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        // Commit a field that is still being typed in (inline titles commit on blur).
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        // A no-op while a conflict is open: that is resolved from the conflict banner.
        void editor.save();
      } else if (e.key === 'Escape') {
        cancelPlacing();
        cancelMove();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // Every render: Esc has to undo the move or the placing drag as it stands now.
  });

  const removeScene = (panoId: string) => {
    dispatch({ type: 'tour/remove-scene', panoId });
    if (panoId === currentId) {
      const next = sceneIds.find((id) => id !== panoId);
      openPoint(null);
      setParams(next ? { pano: next } : {}, { replace: true });
    }
  };

  // The picker appended it on the server: fold it in like an upload, then show it.
  const addedFromLibrary = async (panoId: string, title: string) => {
    const synced = await editor.syncAppended();
    setLibraryOpen(false);
    // Kept even if the sync failed: the scene shows as soon as a later sync brings it in.
    select(panoId);
    if (!synced) {
      editor.notify({
        id: 'library-sync',
        tone: 'warn',
        text: `“${title}” was added to the tour, but the editor couldn’t refresh to show it. Reload the page to see it.`,
      });
    }
  };

  // The image goes up now, to a fresh key; the tour points at it from the next Save.
  const addPlanImage = async (file: File) => {
    setPlanError(null);
    setPlanUploading(true);
    try {
      const plan = await uploadPlanImage(
        {
          upload: session.upload,
          prepare: uploadEnv.preparePlan ?? preparePlanImage,
          ...(uploadEnv.createXhr && { createXhr: uploadEnv.createXhr }),
        },
        docs.tourId,
        file,
      );
      dispatch({ type: 'tour/plan', plan });
    } catch (e) {
      if (!(e instanceof PlanImageError)) console.error('plan image upload failed', e);
      setPlanError(
        e instanceof PlanImageError ? e.message : 'The image couldn’t be added. Try again.',
      );
    } finally {
      setPlanUploading(false);
    }
  };
  const planImage = tour.plan
    ? {
        url: `${config.cdnBase}${planKey(docs.tourId, tour.plan.id, tour.plan.type)}`,
        width: tour.plan.width,
        height: tour.plan.height,
      }
    : null;

  const missingName = scene?.kind === 'missing' ? 'Missing pano' : null;
  const conflictBusy = editor.saving;

  return (
    <main ref={frame} className="ed">
      <title>{`${tour.title} · Editor · panote`}</title>
      {(cfg || pendingCurrent) && currentId ? (
        <PanoStage
          className="ed-stage"
          baseUrl={tilesBaseUrl(config)}
          panoId={currentId}
          reloadKey={reloadKey}
          preview={uploads.previewFor(currentId)}
          {...(cfg?.initialView && { view: cfg.initialView })}
          north={cfg?.north ?? 0}
          {...(createViewer && { createViewer })}
          onViewer={setViewer}
          onLoadError={(err, panoId) => {
            // No tiles yet is expected while an upload here is still on its way.
            if (liveJob(panoId)) return;
            console.error('pano load failed', err);
            setFailedLoad(loadKey);
            // After a reload nothing else is watching it: find out whether it's tiling.
            setStageMisses((m) => (m.includes(panoId) ? m : [...m, panoId]));
          }}
          aria-label={`${tour.title}: ${cfg?.title ?? pendingCurrent?.fileName ?? ''}`}
        >
          <FloorLinks key={`links-${currentId}`} links={links} onGo={(l) => select(l.to)} />
          <HotspotMarkers
            key={`points-${currentId}`}
            hotspots={markers}
            activeId={activePoint}
            onOpen={(h) => {
              if (lookOnly) return;
              setPlacing(false);
              openPoint(h.id);
            }}
          />
          {placingNow && (
            <PointerLayer
              className="ed-placing"
              hint="Click the pano to drop the point, or drag to size it · Esc to cancel"
              onPick={(at) => placed(drop(at))}
              onDrag={sizeDrag}
              onDragEnd={(at, start) => {
                sizeDrag(at, start);
                placed(sizing.current?.id ?? null);
                sizing.current = null;
              }}
              onCancel={cancelPlacing}
            />
          )}
          {movingNow && (
            <PointerLayer
              className="ed-placing ed-placing--move"
              hint="Click the new spot, or drag the point there · Esc to cancel"
              onPick={(at) => {
                moveTo(at);
                setMoving(null);
              }}
              onDrag={moveTo}
              onDragEnd={(at) => {
                moveTo(at);
                setMoving(null);
              }}
              onCancel={cancelMove}
            />
          )}
          {settings.showCompass && <Compass className="ed-compass" />}
          <ViewerControls fullscreenTarget={frame} position={settings.controls} />
        </PanoStage>
      ) : (
        <div className="ed-stage ed-stage--empty">
          {missingName ? (
            <div className="ed-missing" role="status">
              <i className="fa-solid fa-image" aria-hidden="true" />
              <h2>Missing pano</h2>
              <p>
                {scene?.kind === 'missing' && scene.deleting
                  ? 'This pano is being deleted.'
                  : 'This pano’s photo and settings are gone.'}{' '}
                Remove it from the tour so the tour can be shared again.
              </p>
              <Button
                variant="danger"
                size="sm"
                onClick={() => currentId && setConfirm({ kind: 'remove-pano', panoId: currentId })}
              >
                Remove from tour
              </Button>
            </div>
          ) : (
            <p className="ed-missing" role="status">
              Add a pano to start building this tour.
            </p>
          )}
        </div>
      )}
      {currentId && currentStatus && (
        <StageStatus
          status={currentStatus}
          name={cfg?.title ?? pendingCurrent?.fileName ?? 'This pano'}
          {...(pendingCurrent && {
            uploadLine: pendingLine(pendingCurrent),
            problem: pendingProblem(pendingCurrent),
          })}
          {...(scene &&
            (currentStatus === 'failed' || currentStatus === 'timed-out') && {
              replaceTo: replaceImagePath(docs.tourId, currentId),
              onRemove: () => setConfirm({ kind: 'remove-pano', panoId: currentId }),
            })}
          {...(currentStatus === 'timed-out' &&
            !checkingOn(currentId) && {
              onCheckAgain: () => {
                if (!uploads.checkAgain(currentId)) watch.checkAgain(currentId);
              },
            })}
        />
      )}
      {currentId && !currentStatus && watch.polled[currentId]?.state === 'signed-out' && (
        <p className="ed-stage-note" role="status">
          Sign in again to see whether this pano has finished processing.
        </p>
      )}
      {failedLoad === loadKey &&
        cfg &&
        !currentStatus &&
        watch.polled[currentId ?? '']?.state !== 'signed-out' && (
          <p className="ed-stage-note" role="status">
            This pano’s tiles aren’t ready yet. They appear once processing finishes.
          </p>
        )}

      <header className="ed-bar">
        <div className="ed-bar__left">
          <Link to="/" className="ed-home" aria-label="Your tours">
            <LogoMark size={30} />
          </Link>
          <nav className="ed-crumbs" aria-label="Tour">
            <InlineText
              className="ed-crumbs__tour"
              label="Tour title"
              {...(tr(tour.title, tour.i18n, 'title') ?? { value: tour.title })}
              onCommit={(title) => dispatch({ type: 'tour/title', title, ...(lang && { lang }) })}
            />
            <i className="fa-solid fa-chevron-right ed-crumbs__sep" aria-hidden="true" />
            {cfg && currentId ? (
              <InlineText
                className="ed-crumbs__pano"
                label="Pano name"
                {...(tr(cfg.title, cfg.i18n, 'title') ?? { value: cfg.title })}
                disabled={lookOnly}
                onCommit={(title) =>
                  dispatch({ type: 'scene/title', panoId: currentId, title, ...(lang && { lang }) })
                }
              />
            ) : (
              <span className="ed-crumbs__pano">
                {missingName ?? pendingCurrent?.fileName ?? '—'}
              </span>
            )}
            <i className="fa-solid fa-pen ed-crumbs__pen" aria-hidden="true" />
          </nav>
        </div>
        <div className="ed-bar__right">
          <button
            type="button"
            className="ed-glass-btn ed-lang-btn"
            aria-label={`Language: ${languageName(lang ?? defaultLang)}`}
            aria-expanded={languagesOpen}
            data-languages-toggle
            onClick={() => {
              setSettingsOpen(false);
              setLanguagesOpen((o) => !o);
            }}
          >
            <i className="fa-solid fa-globe" aria-hidden="true" />
            <span className="ed-lang-btn__tag">{lang ?? defaultLang}</span>
          </button>
          <button
            type="button"
            className="ed-glass-btn ed-glass-btn--icon"
            aria-label="Tour settings"
            aria-expanded={settingsOpen}
            data-settings-toggle
            onClick={() => {
              setLanguagesOpen(false);
              setSettingsOpen((o) => !o);
            }}
          >
            <i className="fa-solid fa-sliders" aria-hidden="true" />
          </button>
          <Link className="ed-glass-btn" to="insights">
            Insights
          </Link>
          <Link
            className="ed-glass-btn"
            to={`/t/${docs.tourId}/preview${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`}
          >
            Preview
          </Link>
          <SaveButton editor={editor} />
          <Link className="pn-btn pn-btn--accent pn-btn--pill" to="share/link">
            Share
          </Link>
          <OwnerAccountMenu session={session} />
        </div>
      </header>
      {settingsOpen && (
        <SettingsPopover
          // A fresh draft per language.
          key={lang ?? ''}
          settings={settings}
          description={lang ? (tour.i18n?.[lang]?.description ?? '') : (tour.description ?? '')}
          {...(translation && {
            translating: { name: translation.name, placeholder: tour.description ?? '' },
          })}
          onChange={(patch) => dispatch({ type: 'tour/settings', settings: patch })}
          onDescription={(description) =>
            dispatch({ type: 'tour/description', description, ...(lang && { lang }) })
          }
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {languagesOpen && (
        <LanguageMenu
          languages={tour.languages}
          editing={lang ?? defaultLang}
          onEdit={(l) => setEditLang(l === defaultLang ? null : l)}
          onChange={(languages) => dispatch({ type: 'tour/languages', languages })}
          onRemove={(l) => setConfirm({ kind: 'remove-language', lang: l })}
          onClose={() => setLanguagesOpen(false)}
        />
      )}

      <aside className="ed-side" aria-label="Editor panels">
        <section className="ed-card ed-points" aria-labelledby="ed-points-title">
          <header className="ed-card__head">
            <h2 id="ed-points-title" className="ed-card__title">
              Points <span className="ed-card__count">{points.length}</span>
            </h2>
            <Button
              variant="accent"
              size="sm"
              pill
              icon={placingNow ? 'fa-solid fa-xmark' : 'fa-solid fa-plus'}
              disabled={!cfg || !viewer || lookOnly}
              aria-pressed={placingNow}
              onClick={() => {
                openPoint(null);
                setPlacing((p) => !p);
              }}
            >
              {placingNow ? 'Cancel' : 'Add point'}
            </Button>
          </header>
          {translation && (
            <p className="ed-hint ed-translating" role="note">
              <i className="fa-solid fa-globe" aria-hidden="true" /> Translating into{' '}
              {translation.name}. Blank fields show the {languageName(defaultLang)} text.
            </p>
          )}
          {cfg && sceneTranslationChars(cfg) > MAX_SCENE_TRANSLATION_CHARS && (
            <p className="ed-note ed-note--error" role="alert">
              This pano’s translations are over the{' '}
              {MAX_SCENE_TRANSLATION_CHARS.toLocaleString('en')}-character limit, so it can’t be
              saved. Shorten some of them.
            </p>
          )}
          {lookOnly && (
            <p className="ed-hint ed-look-only" role="note">
              <i className="fa-solid fa-eye" aria-hidden="true" /> Look-only while the image
              uploads: editing unlocks once it lands.
            </p>
          )}
          {cfg && currentId && (
            <div className="ed-pano-settings" role="group" aria-label="This pano">
              <SceneDescription
                // A fresh draft per pano and language.
                key={`${currentId}:${lang ?? ''}`}
                value={lang ? (cfg.i18n?.[lang]?.description ?? '') : (cfg.description ?? '')}
                {...(translation && {
                  translating: { name: translation.name, placeholder: cfg.description ?? '' },
                })}
                disabled={lookOnly}
                onChange={(description) =>
                  dispatch({
                    type: 'scene/description',
                    panoId: currentId,
                    description,
                    ...(lang && { lang }),
                  })
                }
              />
              <div className="ed-pano-settings__row">
                <span className="ed-label">Start view</span>
                <span className="ed-mono">
                  {cfg.initialView ? `${yawDegrees(cfg.initialView.yaw)}°` : 'default'}
                </span>
                <button
                  type="button"
                  className="ed-conn__aim"
                  disabled={!viewer || lookOnly}
                  onClick={() => {
                    const v = view();
                    if (!v) return;
                    const fov = Math.min(FOV_MAX, Math.max(FOV_MIN, v.fov));
                    dispatch({ type: 'scene/start-view', panoId: currentId, view: { ...v, fov } });
                  }}
                >
                  <i className="fa-solid fa-flag" aria-hidden="true" /> Start here
                </button>
              </div>
              <div className="ed-pano-settings__row">
                <span className="ed-label">North</span>
                <span className="ed-mono">{yawDegrees(cfg.north ?? 0)}°</span>
                <button
                  type="button"
                  className="ed-conn__aim"
                  disabled={!viewer || lookOnly}
                  onClick={() => {
                    const v = view();
                    if (v) dispatch({ type: 'scene/north', panoId: currentId, north: v.yaw });
                  }}
                >
                  <i className="fa-solid fa-compass" aria-hidden="true" /> North is here
                </button>
              </div>
            </div>
          )}
          {point && currentId ? (
            <PointEditor
              key={`${point.id}:${lang ?? ''}`}
              point={point}
              translation={translation}
              onTranslate={(patch) =>
                lang &&
                dispatch({ type: 'point/translate', panoId: currentId, id: point.id, lang, patch })
              }
              onChange={(patch) =>
                dispatch({ type: 'point/update', panoId: currentId, id: point.id, patch })
              }
              onFace={() => viewer?.setView({ yaw: point.yaw, pitch: point.pitch })}
              moving={movingNow !== null}
              onMove={() => {
                if (movingNow) {
                  cancelMove();
                  return;
                }
                setPlacing(false);
                setMoving({ panoId: currentId, id: point.id, yaw: point.yaw, pitch: point.pitch });
              }}
              onDuplicate={() => {
                const id = newId('pt');
                dispatch({ type: 'point/duplicate', panoId: currentId, id: point.id, newId: id });
                openPoint(id);
              }}
              onDelete={() =>
                setConfirm({
                  kind: 'delete-point',
                  panoId: currentId,
                  id: point.id,
                  title: point.title,
                })
              }
              onDone={() => openPoint(null)}
            />
          ) : (
            points.length > 0 && (
              <ul className="ed-points__list">
                {points.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      className="ed-points__item"
                      disabled={lookOnly}
                      onClick={() => openPoint(h.id)}
                    >
                      <i className={`fa-solid fa-${pointIcon(h.icon)}`} aria-hidden="true" />
                      {localizeHotspot(h, lang).title}
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}
        </section>
        <TourPanel
          docs={docs}
          currentId={currentId}
          startId={startId}
          dirty={dirty.length > 0}
          pending={pendingCards}
          statusOf={statusFor}
          lookOnly={lookOnly}
          onSelect={select}
          onSetStart={(panoId) => dispatch({ type: 'tour/start', panoId })}
          onRemove={(panoId) => setConfirm({ kind: 'remove-pano', panoId })}
          onAim={(to, title) => {
            const v = view();
            if (v && currentId)
              dispatch({ type: 'link/set', from: currentId, to, yaw: v.yaw, title });
          }}
          onNudge={(to, delta) =>
            currentId && dispatch({ type: 'link/nudge', from: currentId, to, delta })
          }
          onDisconnect={(to) => currentId && dispatch({ type: 'link/remove', from: currentId, to })}
          onAddFromLibrary={() => setLibraryOpen(true)}
          onAddPano={() => uploads.pick({ kind: 'add', tourId: docs.tourId })}
        />
        <MapPanel
          docs={docs}
          currentId={currentId}
          plan={planImage}
          uploading={planUploading}
          planError={planError}
          onPlace={(panoId, x, y) => dispatch({ type: 'map/place', panoId, x, y })}
          onRemove={(panoId) => dispatch({ type: 'map/remove', panoId })}
          onSuggest={(positions) => dispatch({ type: 'map/suggest', positions })}
          onSelect={select}
          onPlanFile={(file) => void addPlanImage(file)}
          onRemovePlan={() => {
            setPlanError(null);
            dispatch({ type: 'tour/plan', plan: null });
          }}
        />
      </aside>

      <div className="ed-banners">
        {editor.conflicts.length > 0 && (
          <ConflictBanner
            docs={docs}
            conflicts={editor.conflicts}
            busy={conflictBusy}
            onReload={() => void editor.reloadConflicts()}
            onOverwrite={() => void editor.overwriteConflicts()}
          />
        )}
        <ErrorBanner
          docs={docs}
          failures={editor.failures}
          busy={editor.saving}
          blocked={editor.conflicts.length > 0}
          onRetry={() => void editor.save()}
        />
        <Notices
          notices={editor.notices}
          onDismiss={editor.dismiss}
          busy={editor.publishing}
          onRepublish={() => void editor.republish()}
          onDiscardDraft={() => void editor.discardDraft()}
          saving={editor.saving}
          failed={Object.keys(editor.failures).length > 0}
        />
      </div>

      <ConfirmModal
        open={confirm?.kind === 'remove-pano'}
        title="Remove pano from tour?"
        body={(() => {
          if (confirm?.kind !== 'remove-pano') return null;
          const s = docs.scenes[confirm.panoId];
          return s?.kind === 'config'
            ? `“${s.current.title}” becomes a standalone pano. Its points and photo are kept.`
            : 'This pano no longer exists. Removing it lets the tour be shared again.';
        })()}
        confirmLabel="Remove from tour"
        onConfirm={() => {
          if (confirm?.kind === 'remove-pano') removeScene(confirm.panoId);
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm?.kind === 'delete-point'}
        title="Delete point?"
        body={
          confirm?.kind === 'delete-point' ? `“${confirm.title}” is removed when you save.` : null
        }
        confirmLabel="Delete point"
        onConfirm={() => {
          if (confirm?.kind === 'delete-point') {
            dispatch({ type: 'point/remove', panoId: confirm.panoId, id: confirm.id });
            openPoint(null);
          }
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm?.kind === 'remove-language'}
        title="Remove language?"
        body={
          confirm?.kind === 'remove-language'
            ? `Visitors stop seeing this tour in ${languageName(confirm.lang)} when you save, and its ${languageName(confirm.lang)} title and description are removed. Pano and point translations stay with each pano, ready if you add the language back.`
            : null
        }
        confirmLabel="Remove language"
        onConfirm={() => {
          if (confirm?.kind === 'remove-language') {
            dispatch({ type: 'lang/remove', lang: confirm.lang });
            if (editLang === confirm.lang) setEditLang(null);
          }
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={blocker.state === 'blocked'}
        title="Leave without saving?"
        body="Your unsaved changes to this tour will be lost."
        confirmLabel="Leave"
        cancelLabel="Stay"
        onConfirm={() => {
          editor.forgetDraft();
          blocker.proceed?.();
        }}
        onCancel={() => blocker.reset?.()}
      />
      {libraryOpen && (
        <LibraryPicker
          tourId={docs.tourId}
          tourPanoIds={[...sceneIds, ...pendingIds]}
          full={sceneIds.length >= MAX_TOUR_SCENES}
          onClose={() => setLibraryOpen(false)}
          onAdded={addedFromLibrary}
        />
      )}
      <Outlet context={shareContext} />
    </main>
  );
}
