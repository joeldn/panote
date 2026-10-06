import { PanoViewer, type PreviewSource, type View, type ViewerOptions } from '@panote/viewer';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { cx } from './cx.js';
import { PanoViewerContext } from './viewer-context.js';

export type ViewerFactory = (container: HTMLElement, options: ViewerOptions) => PanoViewer;

const defaultFactory: ViewerFactory = (container, options) => new PanoViewer(container, options);

export type StageViewerOptions = Omit<
  ViewerOptions,
  'baseUrl' | 'initialView' | 'north' | 'autoRotate'
>;

/**
 * A local decode to show for a pano before (or instead of) its tiles; see
 * `PanoViewer.showPreview`.
 */
export interface StagePreview {
  /** The pano this is a preview of. Ignored while another pano is on stage. */
  panoId: string;
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
  /** Pano to show; null leaves the stage empty. */
  panoId: string | null;
  /**
   * Camera for each pano as it loads (a scene's `initialView`). Applied on the
   * first load and on a pano change only: a `reloadKey` reload or a new
   * `preview` for the same pano keeps the camera where it is.
   */
  view?: Partial<View>;
  /** Compass north offset for the current pano, radians. */
  north?: number;
  autoRotate?: boolean;
  /**
   * Reloads the current pano when it changes, e.g. the new `manifest.version`
   * once a replace-image upload is ready, so the stage picks up the new tiles.
   */
  reloadKey?: string | number;
  /**
   * Shown over the stage at once when its `panoId` is on stage, then the pano
   * is loaded so its tiles take over. A new object is a new preview: keep it
   * stable (memoize it) between renders, since each new object for the pano
   * on stage is shown and reloads. Dropping it (null) doesn't reload; the
   * viewer disposes the preview itself once its tiles have settled. A load
   * that fails (e.g. no manifest yet) still goes to `onLoadError`, and the
   * preview stays on screen.
   */
  preview?: StagePreview | null;
  /** Crossfade between panos with `transitionTo` instead of a plain `load`. */
  transition?: boolean;
  /** Read once when the viewer is created. */
  options?: StageViewerOptions;
  onViewer?: (viewer: PanoViewer | null) => void;
  onSceneChange?: (panoId: string) => void;
  onHotspotOpen?: (hotspotId: string) => void;
  onLoadError?: (error: unknown, panoId: string) => void;
  /** Viewer chrome, rendered over the canvas with access to `usePanoViewer()`. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  /** Test seam: builds the viewer (defaults to `new PanoViewer`). */
  createViewer?: ViewerFactory;
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
  options,
  onViewer,
  onSceneChange,
  onHotspotOpen,
  onLoadError,
  children,
  className,
  style,
  'aria-label': ariaLabel = 'Panorama viewer',
  createViewer = defaultFactory,
}: PanoStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<PanoViewer | null>(null);

  // Latest props for use inside long-lived effects without re-running them.
  const latest = useRef({ view, north, autoRotate, options, createViewer, transition });
  const callbacks = useRef({ onViewer, onSceneChange, onHotspotOpen, onLoadError });
  useEffect(() => {
    latest.current = { view, north, autoRotate, options, createViewer, transition };
    callbacks.current = { onViewer, onSceneChange, onHotspotOpen, onLoadError };
  });

  // What the stage last loaded, to tell a pano change (apply the scene's view)
  // from a reload of the same pano (keep the camera), and which preview this
  // viewer has already been given (a source can only be shown once).
  const loaded = useRef<{
    viewer: PanoViewer;
    panoId: string;
    reloadKey: string | number | undefined;
    preview: StagePreview | null;
  } | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const l = latest.current;
    const opts: ViewerOptions = { ...l.options, baseUrl, autoRotate: l.autoRotate };
    if (l.view) opts.initialView = l.view;
    if (l.north !== undefined) opts.north = l.north;
    const v = l.createViewer(host, opts);
    const onScene = (id: string) => callbacks.current.onSceneChange?.(id);
    const onHotspot = (id: string) => callbacks.current.onHotspotOpen?.(id);
    v.on('scene-change', onScene);
    v.on('hotspot-open', onHotspot);
    setViewer(v);
    callbacks.current.onViewer?.(v);
    return () => {
      loaded.current = null;
      v.off('scene-change', onScene);
      v.off('hotspot-open', onHotspot);
      callbacks.current.onViewer?.(null);
      setViewer(null);
      v.dispose();
    };
  }, [baseUrl]);

  const stagePreview = preview && panoId !== null && preview.panoId === panoId ? preview : null;

  useEffect(() => {
    if (!viewer || !panoId) return;
    const prev = loaded.current;
    const samePano = prev !== null && prev.viewer === viewer && prev.panoId === panoId;
    const shown = samePano ? prev.preview : null;
    const newPreview = stagePreview !== null && stagePreview !== shown;
    // A preview dropped with nothing else new: nothing to load.
    if (samePano && prev.reloadKey === reloadKey && !newPreview) return;
    const entry = { viewer, panoId, reloadKey, preview: shown };
    loaded.current = entry;
    // Each load gets a fresh entry, and viewer teardown clears it: a callback
    // that finds another entry there was superseded and drops its result.
    const live = () => loaded.current === entry;
    const { view: v, transition: fade } = latest.current;
    const fail = (err: unknown) => {
      if (live()) callbacks.current.onLoadError?.(err, panoId);
    };
    const load = () => {
      viewer.load(panoId).catch(fail);
    };

    // Only the first load on a viewer and a pano change move the camera; a
    // reload or a new preview of the pano on stage keeps it where it is.
    const crossfade = fade && !samePano && prev?.viewer === viewer && !newPreview;
    if (!samePano && v && !crossfade) viewer.setView(v);

    if (!newPreview) {
      if (crossfade) viewer.transitionTo(panoId, v).catch(fail);
      else load();
      return;
    }

    // showPreview cancels any load in flight, so the load follows it.
    const p = stagePreview;
    const show = (source: PreviewSource) => {
      if (!live()) {
        closeSource(source);
        return;
      }
      entry.preview = p;
      const opts = p.replacesVersion === undefined ? {} : { replacesVersion: p.replacesVersion };
      viewer.showPreview(panoId, source, opts);
      load();
    };
    const noPreview = (err: unknown) => {
      if (!live()) return;
      entry.preview = p;
      fail(err);
      load();
    };
    let made: PreviewSource | Promise<PreviewSource>;
    try {
      made = p.source();
    } catch (err) {
      noPreview(err);
      return;
    }
    if ('then' in made) made.then(show, noPreview);
    else show(made);
    // reloadKey is a dependency only to re-run this load when it changes.
  }, [viewer, panoId, reloadKey, stagePreview]);

  useEffect(() => {
    viewer?.setNorth(north ?? 0);
  }, [viewer, north]);

  useEffect(() => {
    viewer?.setAutoRotate(autoRotate);
  }, [viewer, autoRotate]);

  return (
    <div className={cx('pn-stage', className)} style={style}>
      <div ref={hostRef} className="pn-stage__viewer" role="application" aria-label={ariaLabel} />
      <PanoViewerContext.Provider value={viewer}>
        <div className="pn-stage__overlay">{children}</div>
      </PanoViewerContext.Provider>
    </div>
  );
}

function closeSource(source: PreviewSource): void {
  for (const { image } of source.patches) {
    if ('close' in image) image.close();
  }
}
