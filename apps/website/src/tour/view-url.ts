import type { View } from '@internal/ui';

/**
 * The camera in a tour link: `?pano=<scene>&yaw=<deg>&pitch=<deg>&fov=<deg>`, whole
 * degrees, so a link stays short and a view that barely moved writes the same URL.
 */
export const VIEW_PARAMS = ['yaw', 'pitch', 'fov'] as const;

const DEG = 180 / Math.PI;

/** Degrees wrapped into (−180, 180]. */
export function wrapDegrees(deg: number): number {
  const w = ((deg % 360) + 360) % 360;
  return w > 180 ? w - 360 : w;
}

const num = (raw: string | null): number | null => {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * The view a link asks for, in radians; null when it asks for none. A yaw any number of
 * turns round is wrapped into (−180°, 180°]; a pitch or fov out of range, or anything
 * that isn't a finite number, is dropped.
 */
export function viewFromParams(params: URLSearchParams): Partial<View> | null {
  const yaw = num(params.get('yaw'));
  const pitch = num(params.get('pitch'));
  const fov = num(params.get('fov'));
  const view: Partial<View> = {
    ...(yaw !== null && { yaw: wrapDegrees(yaw) / DEG }),
    ...(pitch !== null && Math.abs(pitch) <= 90 && { pitch: pitch / DEG }),
    ...(fov !== null && fov > 0 && fov < 180 && { fov }),
  };
  return Object.keys(view).length ? view : null;
}

/** `view` as whole degrees, yaw in (−180, 180]. */
export function roundView(view: View): { yaw: number; pitch: number; fov: number } {
  // `|| 0` turns a -0 into 0, so it never reads "-0".
  return {
    yaw: wrapDegrees(Math.round(view.yaw * DEG)) || 0,
    pitch: Math.round(view.pitch * DEG) || 0,
    fov: Math.round(view.fov),
  };
}

/** `params` with the scene and, when given, the camera; a scene without a view drops it. */
export function withView(
  params: URLSearchParams,
  panoId: string,
  view: View | null,
): URLSearchParams {
  const out = new URLSearchParams(params);
  out.set('pano', panoId);
  for (const k of VIEW_PARAMS) out.delete(k);
  if (view) {
    const r = roundView(view);
    for (const k of VIEW_PARAMS) out.set(k, String(r[k]));
  }
  return out;
}

/** Whether two sets of params say the same thing (order aside). */
export function sameParams(a: URLSearchParams, b: URLSearchParams): boolean {
  const sa = new URLSearchParams(a);
  const sb = new URLSearchParams(b);
  sa.sort();
  sb.sort();
  return sa.toString() === sb.toString();
}
