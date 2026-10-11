import type { PreviewSource } from './equirect-layer.js';
import type { CubeTileSource } from './source.js';
import type {
  LoadOptions,
  PanoViewerEvents,
  PrefetchOptions,
  ProjectedPoint,
  ShowPreviewOptions,
  View,
} from './types.js';

/**
 * What a host can call on a viewer: `PanoViewer`'s public methods, documented
 * there. Type references to a viewer, and test doubles of one, against this
 * rather than the class, so a double that drifts from the viewer fails to
 * compile instead of passing a cast.
 */
export interface PanoViewerApi {
  on<K extends keyof PanoViewerEvents>(
    type: K,
    fn: (payload: PanoViewerEvents[K]) => void,
  ): () => void;
  off<K extends keyof PanoViewerEvents>(type: K, fn: (payload: PanoViewerEvents[K]) => void): void;
  load(source: CubeTileSource | string, options?: LoadOptions): Promise<boolean>;
  cancelLoad(): void;
  showPreview(id: string, source: PreviewSource, options?: ShowPreviewOptions): void;
  prefetch(source: CubeTileSource | string, options?: PrefetchOptions): Promise<void>;
  setView(view: Partial<View>): void;
  getView(): View;
  zoomBy(factor: number): void;
  setNorth(radians: number): void;
  heading(): number;
  setAutoRotate(enabled: boolean): void;
  setLabel(label: string): void;
  focus(): void;
  isSettled(): boolean;
  project(yaw: number, pitch: number, out?: ProjectedPoint): ProjectedPoint;
  directionAtPixel(px: number, py: number): { yaw: number; pitch: number };
  onRender(cb: (view: Readonly<View>) => void): () => void;
  requestRender(): void;
  dispose(): void;
}
