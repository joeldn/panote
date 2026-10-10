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
   * is loaded so its tiles take over. A new `key` is a new preview (shown, then
   * reloaded); the same key again is a no-op. Dropping it (null) doesn't
   * reload; the viewer disposes the preview itself once its tiles have
   * settled. A preview that can't be shown goes to `onPreviewError` and the
   * tiles load anyway. A tile load that fails (e.g. no manifest yet) goes to
   * `onLoadError`, and the preview stays on screen.
   */
  preview?: StagePreview | null;
  /** Crossfade between panos with `transitionTo` instead of a plain `load`. */
  transition?: boolean;
  /** Read once when the viewer is created. */
  options?: StageViewerOptions;
  onViewer?: (viewer: PanoViewer | null) => void;
  onSceneChange?: (panoId: string) => void;
  onHotspotOpen?: (hotspotId: string) => void;
  /** A tile load for `panoId` failed. Preview failures are not reported here. */
  onLoadError?: (error: unknown, panoId: string) => void;
  /** `preview` could not be shown: its `source` threw or rejected, or the viewer refused it. */
  onPreviewError?: (error: unknown, panoId: string) => void;
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
  onPreviewError,
  children,
  className,
  style,
  'aria-label': ariaLabel = 'Panorama viewer',
  createViewer = defaultFactory,
}: PanoStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<PanoViewer | null>(null);

  // Latest props for use inside long-lived effects without re-running them.
  const latest = useRef({ view, north, autoRotate, options, createViewer, transition, preview });
  const callbacks = useRef({
    onViewer,
    onSceneChange,
    onHotspotOpen,
    onLoadError,
    onPreviewError,
  });
  useEffect(() => {
    latest.current = { view, north, autoRotate, options, createViewer, transition, preview };
    callbacks.current = { onViewer, onSceneChange, onHotspotOpen, onLoadError, onPreviewError };
  });

  // What the stage last loaded, to tell a pano change (apply the scene's view)
  // from a reload of the same pano (keep the camera), and which preview this
  // viewer has already been given (a source can only be shown once).
  const loaded = useRef<{
    viewer: PanoViewer;
    panoId: string;
    reloadKey: string | number | undefined;
    previewKey: string | null;
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

  const stagePreviewKey =
    preview && panoId !== null && preview.panoId === panoId ? preview.key : null;

  useEffect(() => {
    if (!viewer) return;
    if (!panoId) {
      // Forget the last pano so coming back to it loads it again.
      loaded.current = null;
      return;
    }
    const prev = loaded.current;
    const samePano = prev !== null && prev.viewer === viewer && prev.panoId === panoId;
    const shownKey = samePano ? prev.previewKey : null;
    const { view: v, transition: fade, preview: p } = latest.current;
    const newPreview = p && stagePreviewKey !== null && stagePreviewKey !== shownKey ? p : null;
    // A preview dropped with nothing else new: nothing to load.
    if (samePano && prev.reloadKey === reloadKey && !newPreview) return;
    const entry = { viewer, panoId, reloadKey, previewKey: shownKey };
    loaded.current = entry;
    // Each load gets a fresh entry, and a pano of null or viewer teardown
    // clears it: a callback that finds another entry there was superseded and
    // drops its result.
    const live = () => loaded.current === entry;
    const load = (view?: Partial<View>) => {
      (view ? viewer.load(panoId, { view }) : viewer.load(panoId)).catch((err: unknown) => {
        if (live()) callbacks.current.onLoadError?.(err, panoId);
      });
    };

    // Only the first load on a viewer and a pano change move the camera; a
    // reload or a new preview of the pano on stage keeps it where it is.
    const sceneView = !samePano ? v : undefined;
    const crossfade = fade && !samePano && prev?.viewer === viewer && !newPreview;

    if (!newPreview) {
      if (crossfade) {
        viewer.transitionTo(panoId, sceneView).catch((err: unknown) => {
          if (live()) callbacks.current.onLoadError?.(err, panoId);
        });
      } else {
        // The viewer applies the view as the pano swaps in, so neither scene
        // swings round to it.
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
      const opts =
        newPreview.replacesVersion === undefined
          ? {}
          : { replacesVersion: newPreview.replacesVersion };
      // A preview goes on screen at once with the camera as it is, so aim the
      // camera just before it goes up, and not before: an async source may
      // land late, or never.
      if (sceneView) viewer.setView(sceneView);
      try {
        viewer.showPreview(panoId, source, opts);
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
    // reloadKey is a dependency only to re-run this load when it changes.
  }, [viewer, panoId, reloadKey, stagePreviewKey]);

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
    if ('close' in image && typeof image.close === 'function') image.close();
  }
}
