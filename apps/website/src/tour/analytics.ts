// The single hook point for the viewer analytics beacon (scene, hotspot, dwell).
// A no-op until the public-api /events ingest (PR #23) lands; wire the web-kit beacon here.

export type ViewerEvent =
  | { type: 'scene'; tourId: string; panoId: string }
  | { type: 'hotspot'; tourId: string; panoId: string; hotspotId: string };

export function trackViewerEvent(_event: ViewerEvent): void {}
