import type { Manifest } from '@panote/core';

export interface View {
  yaw: number; // radians, around +y
  pitch: number; // radians, [-π/2, π/2]
  fov: number; // vertical fov in degrees
}

export interface ViewerOptions {
  baseUrl?: string; // default '/tiles/'
  minFov?: number; // default 15 (vertical, degrees)
  maxFov?: number; // default 80 (vertical, degrees)
  maxHorizontalFov?: number; // default 100 — caps horizontal fov so wide screens don't over-stretch
  textureBudgetMB?: number; // default 128
  initialView?: Partial<View>; // fov defaults to 70 (vertical, degrees)
  damping?: number; // 0..1 per-frame camera easing toward target; 1 = instant. default 0.25
  momentumFriction?: number; // 0..1 per-frame decay of release inertia; higher = longer glide. default 0.9
  maxPixelRatio?: number; // cap devicePixelRatio (default 2)
  antialias?: boolean; // default false
  maxConcurrent?: number; // max simultaneous tile requests (default 8)
  transitionMs?: number; // crossfade duration in ms (default 400)
}

export type PanoViewerEvents = {
  ready: Manifest;
  'tiles-settled': undefined;
  loading: string;
};
