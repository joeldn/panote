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
import { tilesBaseUrl } from '@internal/web-kit';
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
import { newId, yawDegrees, type ConfigState, type EditorDocs } from './model.js';
import { PointEditor } from './PointEditor.js';
import { SettingsPopover } from './SettingsPopover.js';
import { StageFactoryContext, type Viewer } from './stage-factory.js';
import { TourPanel } from './TourPanel.js';
import { useEditor, type EditorController } from './use-editor.js';

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
  const { origins } = useAuthEnv();
  const createViewer = useContext(StageFactoryContext);
  const [params, setParams] = useSearchParams();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [activePoint, setActivePoint] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [failedLoad, setFailedLoad] = useState<string | null>(null);
  const frame = useRef<HTMLElement>(null);
  const { dispatch, dirty } = editor;
  const tour = docs.tour.current;
  const settings = tour.settings ?? DEFAULT_TOUR_SETTINGS;
  const blocker = useUnsavedGuards(dirty.length > 0, docs.tourId);

  const sceneIds = tour.scenes.map((s) => s.panoId);
  const startId = tour.startPanoId && sceneIds.includes(tour.startPanoId) ? tour.startPanoId : null;
  const requested = params.get('pano');
  const currentId =
    requested && sceneIds.includes(requested) ? requested : (startId ?? sceneIds[0] ?? null);
  const scene = currentId ? docs.scenes[currentId] : undefined;
  const sceneConfig: ConfigState | null = scene?.kind === 'config' ? scene : null;
  const cfg = sceneConfig?.current ?? null;

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

  const points = cfg ? cfg.hotspots.filter((h) => h.type === 'info') : [];
  const point = points.find((h) => h.id === activePoint) ?? null;
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
    if (!viewer || !currentId) return;
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

  const missingName = scene?.kind === 'missing' ? 'Missing pano' : null;
  const conflictBusy = editor.saving;

  return (
    <main ref={frame} className="ed">
      <title>{`${tour.title} · Editor · panote`}</title>
      {cfg && currentId ? (
        <PanoStage
          className="ed-stage"
          baseUrl={tilesBaseUrl(config)}
          panoId={currentId}
          reloadKey={uploads.reloadKeyFor(currentId) ?? ''}
          {...(cfg.initialView && { view: cfg.initialView })}
          north={cfg.north ?? 0}
          {...(createViewer && { createViewer })}
          onViewer={setViewer}
          onLoadError={(err) => {
            console.error('pano load failed', err);
            setFailedLoad(currentId);
          }}
          aria-label={`${tour.title}: ${cfg.title}`}
        >
          <FloorLinks key={`links-${currentId}`} links={links} onGo={(l) => select(l.to)} />
          <HotspotMarkers
            key={`points-${currentId}`}
            hotspots={points.map(toViewerHotspot)}
            activeId={activePoint}
            onOpen={(h) => {
              setPlacing(false);
              setActivePoint(h.id);
            }}
          />
          {placing && (
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
      {failedLoad === currentId && cfg && (
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
                onCommit={(title) => dispatch({ type: 'scene/title', panoId: currentId, title })}
              />
            ) : (
              <span className="ed-crumbs__pano">{missingName ?? '—'}</span>
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
              icon={placing ? 'fa-solid fa-xmark' : 'fa-solid fa-plus'}
              disabled={!cfg || !viewer}
              aria-pressed={placing}
              onClick={() => {
                setActivePoint(null);
                setPlacing((p) => !p);
              }}
            >
              {placing ? 'Cancel' : 'Add point'}
            </Button>
          </header>
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
                  disabled={!viewer}
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
                  disabled={!viewer}
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
      <Outlet />
    </main>
  );
}
