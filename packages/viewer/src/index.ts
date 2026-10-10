export * from './types.js';
export { PanoViewer } from './PanoViewer.js';
export { prefetchPano, type PrefetchOptions } from './prefetch.js';
export {
  PREVIEW_GUTTER_PX,
  PREVIEW_MAX_PATCH_PX,
  type PreviewPatch,
  type PreviewSource,
} from './equirect-layer.js';
export { BaseTileLoadError } from './tile-layer.js';
// BaseTileLoadError's documented `cause` type. Exported because that doc tells
// callers to inspect `cause`, and a documented type a caller cannot name leaves
// them string-matching a message instead. `permanent` covers the common
// "published or not" question; `TileHttpError.status` is for the callers that
// need to tell a 401 (sign in) from a 404 (no such panorama), which the boolean
// collapses together.
export { TileHttpError } from './tile-retry.js';
export type { Manifest } from '@panote/core';
