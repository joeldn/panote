import type { View } from '../types.js';

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

export function arrivalView(link: TourLink): Partial<View> {
  return { yaw: link.yaw };
}
