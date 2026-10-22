// The tour's floor plan (the viewer's mini-map): where each scene sits, and an optional
// image behind the dots.
//
// Coordinates: a scene's `mapX`/`mapY` are fractions of the plan, 0..1, x to the right
// and y down, so (0, 0) is the plan's top-left corner and (1, 1) its bottom-right. With
// an image they are fractions of the image. The plan is drawn with north at the top, so
// a scene with a north offset can show which way its view faces.
//
// Tours saved before this convention may hold other numbers (any consistent units). The
// schema still takes any finite value, and `fitMapPositions` fits such a set into the
// plan box the way the viewer always drew it, so an old tour looks the same.

/** Most bytes a plan image may have (upload-api signs this cap into the PUT). */
export const MAX_PLAN_BYTES = 4 * 1024 * 1024;
/** Longest side a stored plan's width or height may claim, in px. */
export const MAX_PLAN_EDGE = 4096;

export interface MapPoint {
  x: number;
  y: number;
}

const inUnit = (v: number): boolean => v >= 0 && v <= 1;

/** Whether every position is already a 0..1 plan fraction (this convention). */
export const isUnitMap = (points: Iterable<MapPoint>): boolean => {
  for (const p of points) if (!inUnit(p.x) || !inUnit(p.y)) return false;
  return true;
};

// Legacy fit: the bounding box into 8%..92% of the plan, a lone value on an axis centred.
const LEGACY_MARGIN = 0.08;
const fit = (v: number, min: number, max: number): number =>
  max === min ? 0.5 : LEGACY_MARGIN + ((v - min) / (max - min)) * (1 - 2 * LEGACY_MARGIN);

/**
 * Positions as 0..1 plan fractions. Positions that already are come back as they are;
 * otherwise (an older tour) the whole set is fitted into the plan by its bounding box.
 */
export function fitMapPositions<K>(positions: ReadonlyMap<K, MapPoint>): Map<K, MapPoint> {
  if (isUnitMap(positions.values())) return new Map(positions);
  const xs = [...positions.values()].map((p) => p.x);
  const ys = [...positions.values()].map((p) => p.y);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const out = new Map<K, MapPoint>();
  for (const [k, p] of positions) out.set(k, { x: fit(p.x, minX, maxX), y: fit(p.y, minY, maxY) });
  return out;
}

/** A plan fraction as stored: clamped to 0..1 and rounded to 4 places (0.1 mm on a 1 m plan). */
export const toMapCoord = (v: number): number =>
  Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000 : 0.5;
