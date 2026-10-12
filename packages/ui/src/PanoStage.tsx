import {
  mergeViewerOptions,
  PanoViewer,
  WebGLUnavailableError,
  type PanoViewerApi,
  type PreviewSource,
  type View,
  type ViewerOptions,
} from '@panote/viewer';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { cx } from './cx.js';
import { panoteViewerPreset } from './panote-viewer.js';
import { StageEventsContext, type StageEvents } from './stage-events.js';
import { PanoViewerContext } from './viewer-context.js';

export type ViewerFactory = (container: HTMLElement, options: ViewerOptions) => PanoViewerApi;

/**
 * Keyboard focus (not a click or tap) on the viewer's canvas, a marker or an open
 * point's panel, where a moving scene would pull away what the visitor is reading
 * or about to use.
 */
const HOLDS_ROTATION =
  ':is(.pn-stage__viewer *,.pn-anchors *,.pn-hspanel,.pn-hspanel *):focus-visible';

const defaultFactory: ViewerFactory = (container, options) => new PanoViewer(container, options);

/**
 * Viewer options for one stage, deep-merged over `panoteViewerPreset`: set
 * only what differs, e.g. `{ camera: { maxFov: 90 } }`. The resolver is the
 * stage's own (from `baseUrl`), and the stage's props win over these:
 * `view`, `north`, `autoRotate`, `aria-label` and `embed`. Leave
 * `network.requestInit` alone: the Worker's preloads are only reused by
 * requests that match them.
 */
export type StageViewerOptions = Omit<ViewerOptions, 'resolveSource' | 'initialView'>;

/**
 * A local decode to show for a pano before (or instead of) its tiles; see
 * `PanoViewer.showPreview`.
 */
export interface StagePreview {
  /** The pano this is a preview of. Ignored while another pano is on stage. */
  panoId: string;
  /**
   * Identifies this preview, e.g. the upload job id. The stage compares
   * `panoId` + `key`, not object identity: rebuilding the object with the same
   * key (say on every status poll) does nothing, while a new key for the pano
   * on stage shows the new preview and reloads.
   */
  key: string;
  /**
   * Builds a fresh source. The viewer takes ownership of what this returns and
   * closes its bitmaps once they are uploaded, so a source can only be shown
   * once: return a new decode on every call (e.g. from the stored WebP), not
   * the same object twice. The stage calls it each time the preview has to go
   * on screen: first show, a return to this pano, a remount or `baseUrl`
   * change, or a reload that lands while an async call is still pending (that
   * call's source is then closed unshown).
   */
  source: () => PreviewSource | Promise<PreviewSource>;
  /**
   * For a replace-image: the version of the manifest the new image replaces
   * (`''` for an unversioned one). Leave it out for a new pano.
   */
  replacesVersion?: string;
}

export interface PanoStageProps {
  /** Tiles base, e.g. `tilesBaseUrl(config)`; changing it recreates the viewer. */
  baseUrl: string;
  /**
   * Pano to show. Null empties the stage: the canvas is hidden, and a load
   * still in flight is dropped (its scene-change is not reported).
   */
  panoId: string | null;
  /**
   * Camera for each pano as it loads (a scene's `initialView`). Applied on the
   * first load and on a pano change only: a `reloadKey` reload or a new
   * `preview` for the same pano keeps the camera where it is.
   */
  view?: Partial<View>;
  /** Compass north offset for the current pano, radians. */
  north?: number;
  /**
   * Idle auto-rotate. It holds still while the viewer or a marker has keyboard
   * focus (WCAG 2.2.2), and goes on once focus leaves them.
   */
  autoRotate?: boolean;
  /**
   * Reloads the current pano when it changes, e.g. the new `manifest.version`
   * once a replace-image upload is ready, so the stage picks up the new tiles.
   */
  reloadKey?: string | number;
  /**
   * Shown over the stage at once when its `panoId` is on stage, then the pano
   * is loaded so its tiles take over. A new `key` is a new preview (shown, then
   * reloaded); the same key again is a no-op. Dropping it (null) doesn't
   * reload; the viewer disposes the preview itself once its tiles have
   * settled. A preview that can't be shown goes to `onPreviewError` and the
   * tiles load anyway. A tile load that fails (e.g. no manifest yet) goes to
   * `onLoadError`, and the preview stays on screen. A preview still set for
   * the pano on stage is shown again after a WebGL context restore, since the
   * viewer drops it when the context is lost.
   */
  preview?: StagePreview | null;
  /** Crossfade between panos (a `load` with `transition`) instead of cutting. */
  transition?: boolean;
  /**
   * The stage sits in someone else's page (the website's /embed): a plain
   * wheel scrolls that page until the visitor engages the viewer (a click,
   * a tap or focus), rather than zooming. Changing it recreates the viewer.
   */
  embed?: boolean;
  /** Read once when the viewer is created. */
  options?: StageViewerOptions;
  onViewer?: (viewer: PanoViewerApi | null) => void;
  onSceneChange?: (panoId: string) => void;
  /** Chrome inside the stage opened a point (see `useStageEvents`). */
  onHotspotOpen?: (hotspotId: string) => void;
  /**
   * A tile load for `panoId` failed, including the reload the viewer runs on
   * its own after a WebGL context restore. Preview failures are not reported
   * here.
   */
  onLoadError?: (error: unknown, panoId: string) => void;
  /** `preview` could not be shown: its `source` threw or rejected, or the viewer refused it. */
  onPreviewError?: (error: unknown, panoId: string) => void;
  /** Viewer chrome, rendered over the canvas with access to `usePanoViewer()`. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** The viewer canvas's accessible name; it is `role="application"`. */
  'aria-label'?: string;
  /** Builds the viewer (defaults to `new PanoViewer`); a test passes a `PanoViewerApi` double. */
  createViewer?: ViewerFactory;
}

/** A load the stage started, and what it was given. */
interface StageLoad {
  viewer: PanoViewerApi;
  panoId: string;
  reloadKey: string | number | undefined;
  previewKey: string | null;
  /** The stage's context-restore count when this load was made. */
  restores: number;
  /** Its tile load rejected (and the viewer kept what it had on screen). */
  failed: boolean;
}

/** React host for `@panote/viewer`'s PanoViewer: owns its lifecycle and pano loads. */
export function PanoStage({
  baseUrl,
  panoId,
  reloadKey,
  preview,
  view,
  north,
  autoRotate = false,
  transition = false,
  embed = false,
  options,
  onViewer,
  onSceneChange,
  onHotspotOpen,
  onLoadError,
  onPreviewError,
  children,
  className,
  style,
  'aria-label': ariaLabel = 'Panorama viewer',
  createViewer = defaultFactory,
}: PanoStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<PanoViewerApi | null>(null);
  // Bumped on each WebGL context restore. The viewer drops a preview when the
  // context is lost and reloads only tiles, so the load effect puts the
  // preview back up.
  const [restores, setRestores] = useState(0);
  // The browser has no WebGL2, so there is no viewer to show.
  const [unsupported, setUnsupported] = useState(false);
  // The viewer, a marker or a point's panel has keyboard focus: auto-rotate holds still.
  const [held, setHeld] = useState(false);
  // The viewer's idle window, what auto-rotate was last set to on it, and the resume
  // in waiting.
  const rotation = useRef<{
    idle?: number;
    on?: boolean;
    held?: boolean | undefined;
    timer?: ReturnType<typeof setTimeout>;
  }>({});

  // Latest props for use inside long-lived effects without re-running them.
  const latest = useRef({
    view,
    north,
    autoRotate,
    options,
    createViewer,
    transition,
    preview,
    ariaLabel,
  });
  const callbacks = useRef({
    onViewer,
    onSceneChange,
    onHotspotOpen,
    onLoadError,
    onPreviewError,
  });
  // A layout effect, so the viewer effect below (a layout effect too) reads this
  // render's props.
  useLayoutEffect(() => {
    latest.current = {
      view,
      north,
      autoRotate,
      options,
      createViewer,
      transition,
      preview,
      ariaLabel,
    };
    callbacks.current = { onViewer, onSceneChange, onHotspotOpen, onLoadError, onPreviewError };
  });

  // Handed to chrome through context; reads the latest callback when called.
  const stageEvents = useMemo<StageEvents>(
    () => ({ hotspotOpen: (id) => callbacks.current.onHotspotOpen?.(id) }),
    [],
  );

  // What the stage last loaded, to tell a pano change (apply the scene's view)
  // from a reload of the same pano (keep the camera), and which preview this
  // viewer has already been given (a source can only be shown once).
  const loaded = useRef<StageLoad | null>(null);
  // The load whose pano the viewer last reported on screen ('scene-change').
  const landed = useRef<StageLoad | null>(null);
  // A layout effect: React applies a state update made here at once, so the re-render
  // with the viewer, and the load effect below that starts its first load, run in this
  // same task, before the browser paints, rather than a frame or two later. StrictMode's
  // remount disposes the first viewer before that re-render, so only the second loads.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const l = latest.current;
    const opts = mergeViewerOptions(
      panoteViewerPreset({ baseUrl, label: l.ariaLabel, embed }),
      l.options ?? {},
      { autoRotate: { enabled: l.autoRotate }, camera: { north: l.north }, initialView: l.view },
    );
    // The preset always gives the merged options an autoRotate object.
    rotation.current = { idle: (opts.autoRotate as { idleMs: number }).idleMs };
    const v = createOrNull(l.createViewer, host, opts);
    // No WebGL2: say so in place of the viewer rather than crash the tree.
    setUnsupported(v === null);
    if (!v) return;
    const unsubscribe = [
      v.on('scene-change', ({ id }) => {
        const cur = loaded.current;
        // No load is current (the stage was emptied): this one is stale.
        if (!cur) return;
        landed.current = cur.viewer === v && cur.panoId === id ? cur : null;
        callbacks.current.onSceneChange?.(id);
      }),
      v.on('context-restored', () => setRestores((n) => n + 1)),
      // The viewer's own reload after a restore has no promise to reject.
      v.on('load-error', ({ id, error }) => {
        // That pano is no longer on screen (the restore left the stage blank),
        // so going back to it must load it.
        if (landed.current?.panoId === id) landed.current = null;
        callbacks.current.onLoadError?.(error, id);
      }),
    ];
    setViewer(v);
    callbacks.current.onViewer?.(v);
    return () => {
      loaded.current = null;
      landed.current = null;
      clearTimeout(rotation.current.timer);
      for (const off of unsubscribe) off();
      callbacks.current.onViewer?.(null);
      setViewer(null);
      v.dispose();
    };
  }, [baseUrl, embed]);

  const stagePreviewKey =
    preview && panoId !== null && preview.panoId === panoId ? preview.key : null;

  useEffect(() => {
    if (!viewer) return;
    if (!panoId) {
      // Forget the last pano so coming back to it loads it again, and so a
      // load still in flight is dropped when it lands.
      loaded.current = null;
      landed.current = null;
      return;
    }
    const prev = loaded.current;
    const samePano = prev !== null && prev.viewer === viewer && prev.panoId === panoId;
    // After a context restore the preview is gone from the viewer, so it
    // counts as not shown: the preview path runs again and puts it back over
    // whatever tiles the viewer reloads (for a replace, the old ones).
    const shownKey = samePano && prev.restores === restores ? prev.previewKey : null;
    // A change that failed, or is still in flight, leaves the pano the viewer
    // last landed on screen, so going back to it (TourViewer's snap-back, or
    // the visitor picking it again) needs no load: one would only crossfade it
    // down to its base level and fetch its manifest again. A change in flight
    // is cancelled instead, which keeps the camera too.
    const back = landed.current;
    if (
      prev !== null &&
      !samePano &&
      back?.viewer === viewer &&
      !back.failed &&
      back.panoId === panoId &&
      back.reloadKey === reloadKey &&
      back.restores === restores &&
      (stagePreviewKey === null || stagePreviewKey === back.previewKey)
    ) {
      if (!prev.failed) viewer.cancelLoad();
      loaded.current = { ...back, failed: false };
      return;
    }
    const { view: v, transition: fade, preview: p } = latest.current;
    const newPreview = p && stagePreviewKey !== null && stagePreviewKey !== shownKey ? p : null;
    // A preview dropped with nothing else new: nothing to load.
    if (samePano && prev.reloadKey === reloadKey && !newPreview) {
      prev.restores = restores;
      return;
    }
    const entry: StageLoad = {
      viewer,
      panoId,
      reloadKey,
      previewKey: shownKey,
      restores,
      failed: false,
    };
    loaded.current = entry;
    // Each load gets a fresh entry, and a pano of null or viewer teardown
    // clears it: a callback that finds another entry there was superseded and
    // drops its result.
    const live = () => loaded.current === entry;
    const failed = (err: unknown) => {
      if (!live()) return;
      entry.failed = true;
      callbacks.current.onLoadError?.(err, panoId);
    };
    const load = (view?: Partial<View>) => {
      viewer.load(panoId, { view }).catch(failed);
    };

    // Only the first load on a viewer and a pano change move the camera; a
    // reload or a new preview of the pano on stage keeps it where it is.
    const sceneView = !samePano ? v : undefined;
    const crossfade = fade && !samePano && prev?.viewer === viewer && !newPreview;

    if (!newPreview) {
      // The viewer applies the view as the pano swaps in, so neither scene
      // swings round to it.
      if (crossfade) {
        viewer.load(panoId, { view: sceneView, transition: true }).catch(failed);
      } else {
        load(sceneView);
      }
      return;
    }

    // Whether or not the preview made it up, it's done with for this entry:
    // report a failure, then load the tiles, with the scene's view if it has
    // one (the preview that would have carried it never went up).
    const previewFailed = (err: unknown) => {
      callbacks.current.onPreviewError?.(err, panoId);
      load(sceneView);
    };
    const show = (source: PreviewSource) => {
      if (!live()) {
        closeSource(source);
        return;
      }
      entry.previewKey = newPreview.key;
      // The scene's view is cut to as the preview goes up, as a load cuts to
      // it as the tiles swap in, so the new scene does not swing round. Not
      // before: an async source may land late, or never.
      try {
        viewer.showPreview(panoId, source, {
          replacesVersion: newPreview.replacesVersion,
          view: sceneView,
        });
      } catch (err) {
        // The viewer closes a source it refuses, but make sure.
        closeSource(source);
        previewFailed(err);
        return;
      }
      // showPreview cancels any load in flight, so the load follows it.
      load();
    };
    const noSource = (err: unknown) => {
      if (!live()) return;
      entry.previewKey = newPreview.key;
      previewFailed(err);
    };
    let made: PreviewSource | Promise<PreviewSource>;
    try {
      made = newPreview.source();
    } catch (err) {
      noSource(err);
      return;
    }
    if ('then' in made) made.then(show, noSource);
    else show(made);
    // reloadKey and restores are dependencies only to re-run this load when
    // they change.
  }, [viewer, panoId, reloadKey, stagePreviewKey, restores]);

  useEffect(() => {
    viewer?.setNorth(north ?? 0);
  }, [viewer, north]);

  // After every render, not on a dependency change: a focused element that leaves
  // the DOM (markers remount on a scene change) takes its focus with it, and no blur
  // says so, so where focus is now is checked here.
  useEffect(() => {
    const r = rotation.current;
    const holding = held && document.activeElement?.matches(HOLDS_ROTATION);
    const on = autoRotate && !holding;
    if (!viewer || r.on === on) return;
    clearTimeout(r.timer);
    // Let go of a hold, it waits out the idle window first, as after a drag.
    if (on && r.held) r.timer = setTimeout(() => viewer.setAutoRotate(true), r.idle);
    else viewer.setAutoRotate(on);
    r.on = on;
    r.held = holding;
  });

  useEffect(() => {
    viewer?.setLabel(ariaLabel);
  }, [viewer, ariaLabel]);

  return (
    <div
      className={cx('pn-stage', className)}
      style={style}
      // Focus moving between two elements in the stage blurs one, then focuses the other.
      onFocus={(e) => setHeld(e.target.matches(HOLDS_ROTATION))}
      onBlur={() => setHeld(false)}
    >
      {/* The viewer's canvas is the application landmark, named by aria-label. */}
      <div
        ref={hostRef}
        className="pn-stage__viewer"
        // Empty: hide whatever the viewer last drew, and its canvas from Tab.
        style={panoId ? undefined : { visibility: 'hidden' }}
      />
      {/* Only with a pano to show: an empty stage is empty by design. */}
      {unsupported && panoId && (
        <p className="pn-stage__unsupported" role="alert">
          Your browser can’t display this 360° view.
        </p>
      )}
      <PanoViewerContext.Provider value={viewer}>
        <StageEventsContext.Provider value={stageEvents}>
          <div className="pn-stage__overlay">{children}</div>
        </StageEventsContext.Provider>
      </PanoViewerContext.Provider>
    </div>
  );
}

function closeSource(source: PreviewSource): void {
  for (const { image } of source.patches) {
    if ('close' in image && typeof image.close === 'function') image.close();
  }
}

/** The viewer, or null where the browser has no WebGL2. Any other failure still throws. */
function createOrNull(
  create: ViewerFactory,
  container: HTMLElement,
  options: ViewerOptions,
): PanoViewerApi | null {
  try {
    return create(container, options);
  } catch (err) {
    if (err instanceof WebGLUnavailableError) return null;
    throw err;
  }
}
