import { PanoViewer, type View, type ViewerOptions } from '@panote/viewer';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { cx } from './cx.js';
import { PanoViewerContext } from './viewer-context.js';

export type ViewerFactory = (container: HTMLElement, options: ViewerOptions) => PanoViewer;

const defaultFactory: ViewerFactory = (container, options) => new PanoViewer(container, options);

export type StageViewerOptions = Omit<
  ViewerOptions,
  'baseUrl' | 'initialView' | 'north' | 'autoRotate'
>;

export interface PanoStageProps {
  /** Tiles base, e.g. `tilesBaseUrl(config)`; changing it recreates the viewer. */
  baseUrl: string;
  /** Pano to show; null leaves the stage empty. */
  panoId: string | null;
  /** Camera for each pano as it loads (a scene's `initialView`). Later changes don't move the camera. */
  view?: Partial<View>;
  /** Compass north offset for the current pano, radians. */
  north?: number;
  autoRotate?: boolean;
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
      v.off('scene-change', onScene);
      v.off('hotspot-open', onHotspot);
      callbacks.current.onViewer?.(null);
      setViewer(null);
      v.dispose();
    };
  }, [baseUrl]);

  const loadedOnce = useRef<PanoViewer | null>(null);
  useEffect(() => {
    if (!viewer || !panoId) return;
    let current = true;
    const { view: v, transition: fade } = latest.current;
    const first = loadedOnce.current !== viewer;
    loadedOnce.current = viewer;
    let pending: Promise<void>;
    if (fade && !first) {
      pending = viewer.transitionTo(panoId, v);
    } else {
      if (v) viewer.setView(v);
      pending = viewer.load(panoId);
    }
    pending.catch((err: unknown) => {
      if (current) callbacks.current.onLoadError?.(err, panoId);
    });
    return () => {
      current = false;
    };
  }, [viewer, panoId]);

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
