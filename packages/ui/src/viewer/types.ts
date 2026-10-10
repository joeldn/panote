import type { View } from '@panote/viewer';

/** Hotspot media; structurally the same as `HotspotMedia` in @internal/contracts. */
export type ViewerMedia =
  { kind: 'image' | 'video'; url: string } | { kind: 'youtube'; id: string };

/** An info point as the chrome draws it (angles in radians, as in the viewer). */
export interface ViewerHotspot {
  id: string;
  yaw: number;
  pitch: number;
  title: string;
  body?: string;
  /** Font Awesome solid icon name, e.g. `utensils`. */
  icon?: string;
  /** Marker scale, 0.5..3 (contracts `Hotspot.size`). */
  size?: number;
  media?: ViewerMedia;
}

/** A floor chevron to another scene. */
export interface ViewerLinkArrow {
  to: string;
  yaw: number;
  label: string;
}

/**
 * The scene graph the chrome reads; structurally the same as web-kit's `Tour`
 * (angles in radians, as in the viewer).
 */
export interface ViewerTourGraph {
  start: string;
  scenes: Record<
    string,
    { initialView?: Partial<View>; links: Array<{ to: string; yaw: number; label?: string }> }
  >;
}
