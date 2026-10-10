import type { View } from '@panote/viewer';

export interface TourLink {
  to: string;
  yaw: number; // heading the arrow points / arrival heading
  label?: string;
}
export interface TourScene {
  initialView?: Partial<View>;
  links: TourLink[];
}
export interface Tour {
  start: string;
  scenes: Record<string, TourScene>;
}

export interface InfoHotspotData {
  yaw: number; // radians
  pitch: number; // radians
  title: string;
  /** Markdown body shown in the panel when the hotspot is opened. */
  body?: string;
  /** Optional short caption shown under the title. */
  subtitle?: string;
  /** Stable id reported via the viewer's `hotspot-open` event when set. */
  id?: string;
}
