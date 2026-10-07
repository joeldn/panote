import { DEFAULT_TOUR_SETTINGS, type Hotspot } from '@internal/contracts';
import {
  AccountMenu,
  Button,
  Compass,
  ConfirmModal,
  FloorLinks,
  HotspotMarkers,
  LogoMark,
  PanoStage,
  ViewerControls,
  type ViewerHotspot,
  type ViewerLinkArrow,
} from '@internal/ui';
import { MAX_TOUR_SCENES, tilesBaseUrl } from '@internal/web-kit';
import { useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, Outlet, useBlocker, useParams, useSearchParams } from 'react-router';

import './editor.css';

import { useAuthEnv } from '../auth-context.js';
import { useConfig } from '../config-context.js';
import { writeCurrentTour } from '../dashboard/current-tour.js';
import { useSession } from '../session.js';
import { useUploads } from '../upload/upload-context.js';
import { ConflictBanner, ErrorBanner, Notices } from './Banners.js';
import { InlineText } from './InlineText.js';
import { LibraryPicker } from './LibraryPicker.js';
import { newId, yawDegrees, type ConfigState, type EditorDocs } from './model.js';
import { PointEditor } from './PointEditor.js';
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
import { TourPanel } from './TourPanel.js';
import { replaceImagePath } from './upload-links.js';
import { useEditor, type EditorController } from './use-editor.js';
import { useTilingWatch } from './use-tiling-watch.js';

const FOV_MIN = 15;
const FOV_MAX = 80;

type Confirm =
  | { kind: 'remove-pano'; panoId: string }
  | { kind: 'delete-point'; panoId: string; id: string; title: string };

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
    return (
      <Button
        variant="primary"
        pill
        onClick={() => void editor.save()}
        aria-keyshortcuts="Control+S Meta+S"
      >
        Save
      </Button>
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
  const { origins, fetch: authFetch } = useAuthEnv();
  const createViewer = useContext(StageFactoryContext);
  const [params, setParams] = useSearchParams();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [activePoint, setActivePoint] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [failedLoad, setFailedLoad] = useState<string | null>(null);
  const frame = useRef<HTMLElement>(null);
  const { dispatch, dirty } = editor;
  const tour = docs.tour.current;
  const settings = tour.settings ?? DEFAULT_TOUR_SETTINGS;
  const blocker = useUnsavedGuards(dirty.length > 0, docs.tourId);

  const sceneIds = tour.scenes.map((s) => s.panoId);
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

  const select = (panoId: string) => {
    setActivePoint(null);
    setPlacing(false);
    setFailedLoad(null);
    setParams({ pano: panoId }, { replace: true });
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
        setPlacing(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editor]);

  // Look-only: nothing can be placed or edited on this scene (see `point` below).
  const placingNow = placing && !lookOnly;
  const points = cfg ? cfg.hotspots.filter((h) => h.type === 'info') : [];
  const point = lookOnly ? null : (points.find((h) => h.id === activePoint) ?? null);
  const links: ViewerLinkArrow[] = cfg
    ? cfg.hotspots.flatMap((h) => {
        const target = h.targetPanoId ? docs.scenes[h.targetPanoId] : undefined;
        if (h.type !== 'link' || !h.targetPanoId || !sceneIds.includes(h.targetPanoId)) return [];
        if (h.targetPanoId === currentId || target?.kind !== 'config') return [];
        return [{ to: h.targetPanoId, yaw: h.yaw, label: target.current.title }];
      })
    : [];

  const view = () => viewer?.getView();
  const place = (e: MouseEvent<HTMLDivElement>) => {
    if (!viewer || !currentId || lookOnly) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const { yaw, pitch } = viewer.directionAtPixel(e.clientX - rect.left, e.clientY - rect.top);
    const id = newId('pt');
    dispatch({
      type: 'point/add',
      panoId: currentId,
      hotspot: { id, type: 'info', yaw, pitch, title: 'New point' },
    });
    setPlacing(false);
    setActivePoint(id);
  };

  const removeScene = (panoId: string) => {
    dispatch({ type: 'tour/remove-scene', panoId });
    if (panoId === currentId) {
      const next = sceneIds.find((id) => id !== panoId);
      setActivePoint(null);
      setParams(next ? { pano: next } : {}, { replace: true });
    }
  };

  // The picker appended it on the server: fold it in like an upload, then show it.
  const addedFromLibrary = async (panoId: string) => {
    await editor.syncAppended();
    setLibraryOpen(false);
    select(panoId);
  };

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
            hotspots={points.map(toViewerHotspot)}
            activeId={activePoint}
            onOpen={(h) => {
              if (lookOnly) return;
              setPlacing(false);
              setActivePoint(h.id);
            }}
          />
          {placingNow && (
            <div className="ed-placing" onClick={place} role="presentation">
              <span className="ed-placing__hint">
                Click the pano to drop the point · Esc to cancel
              </span>
            </div>
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
              value={tour.title}
              onCommit={(title) => dispatch({ type: 'tour/title', title })}
            />
            <i className="fa-solid fa-chevron-right ed-crumbs__sep" aria-hidden="true" />
            {cfg && currentId ? (
              <InlineText
                className="ed-crumbs__pano"
                label="Pano name"
                value={cfg.title}
                disabled={lookOnly}
                onCommit={(title) => dispatch({ type: 'scene/title', panoId: currentId, title })}
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
            className="ed-glass-btn ed-glass-btn--icon"
            aria-label="Tour settings"
            aria-expanded={settingsOpen}
            data-settings-toggle
            onClick={() => setSettingsOpen((o) => !o)}
          >
            <i className="fa-solid fa-sliders" aria-hidden="true" />
          </button>
          <Link className="ed-glass-btn" to="insights">
            Insights
          </Link>
          <Link className="ed-glass-btn" to={`/t/${docs.tourId}/preview`}>
            Preview
          </Link>
          <SaveButton editor={editor} />
          <Link className="pn-btn pn-btn--accent pn-btn--pill" to="share/link">
            Share
          </Link>
          <AccountMenu
            user={session.user}
            items={[{ label: 'Home page', icon: 'fa-solid fa-house', href: `${origins.website}/` }]}
            onSignOut={session.signOut}
          />
        </div>
      </header>
      {settingsOpen && (
        <SettingsPopover
          settings={settings}
          onChange={(patch) => dispatch({ type: 'tour/settings', settings: patch })}
          onClose={() => setSettingsOpen(false)}
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
                setActivePoint(null);
                setPlacing((p) => !p);
              }}
            >
              {placingNow ? 'Cancel' : 'Add point'}
            </Button>
          </header>
          {lookOnly && (
            <p className="ed-hint ed-look-only" role="note">
              <i className="fa-solid fa-eye" aria-hidden="true" /> Look-only while the image
              uploads: editing unlocks once it lands.
            </p>
          )}
          {cfg && currentId && (
            <div className="ed-pano-settings" role="group" aria-label="This pano">
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
              key={point.id}
              point={point}
              cdnBase={config.cdnBase}
              onChange={(patch) =>
                dispatch({ type: 'point/update', panoId: currentId, id: point.id, patch })
              }
              onFace={() => viewer?.setView({ yaw: point.yaw, pitch: point.pitch })}
              onDelete={() =>
                setConfirm({
                  kind: 'delete-point',
                  panoId: currentId,
                  id: point.id,
                  title: point.title,
                })
              }
              onDone={() => setActivePoint(null)}
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
                      onClick={() => setActivePoint(h.id)}
                    >
                      <i className={`fa-solid fa-${h.icon ?? 'info'}`} aria-hidden="true" />
                      {h.title}
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
            setActivePoint(null);
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
        onConfirm={() => blocker.proceed?.()}
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
      <Outlet />
    </main>
  );
}
