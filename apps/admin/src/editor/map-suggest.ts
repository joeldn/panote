import type { MapPoint } from '@internal/contracts';

import { mapPositions, type EditorDocs } from './model.js';

// "Suggest positions" on the Map card: a first layout for the panos not on the plan yet,
// from their links and the way each link points. The creator then drags any that are off.
//
// Directions: a link's yaw in pano A, less A's north offset, is the compass bearing from
// A to the linked pano, clockwise from north (the same turn the viewer gives the facing
// wedge on the map). The plan has north at the top, so a bearing b points along
// (sin b, -cos b) on it.
//
// Distances: the layout works in "plan heights", u = x * ratio and v = y, so a bearing
// keeps its angle on a plan that isn't square.

/** How far apart two linked panos are put, in plan heights, when nothing says otherwise. */
export const SUGGEST_STEP = 0.18;
/** New dots stay this far inside the plan's edges (fractions of each side). */
export const SUGGEST_MARGIN = 0.08;
/** Dots closer than this (plan heights) are nudged apart. */
export const SUGGEST_GAP = 0.06;

/** A link point: in `from`, at `yaw`, to `to`. */
export interface SuggestLink {
  from: string;
  to: string;
  yaw: number;
}

export interface SuggestInput {
  /** Every pano in the tour, in tour order. */
  scenes: readonly string[];
  /** Panos already on the plan, as 0..1 fractions. They never move. */
  placed: ReadonlyMap<string, MapPoint>;
  links: readonly SuggestLink[];
  /** North offsets (radians), only for panos whose north is set. */
  north: ReadonlyMap<string, number>;
  /** Where the layout starts when nothing is placed; the first scene if left out. */
  start?: string | undefined;
  /** The plan's width over its height. */
  ratio?: number;
}

/**
 * What a suggestion did. With nothing placed yet, the start pano is put in the middle
 * first and the others are laid out from it: it is in `positions` but not counted in
 * any of the counters, so they can add up to one less than `positions.size`.
 */
export interface SuggestResult {
  /** The new positions, 0..1 fractions, for unplaced panos only. */
  positions: Map<string, MapPoint>;
  /** Placed along a link's direction. */
  fromLinks: number;
  /** Linked, but no link to them had a direction (no north set on either end). */
  noDirection: number;
  /** No link to a pano placed before it, so put by the others, not by a link. */
  unlinked: number;
}

interface Pt {
  u: number;
  v: number;
}

const TWO_PI = Math.PI * 2;
const dist = (a: Pt, b: Pt) => Math.hypot(a.u - b.u, a.v - b.v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Free spots tried round a point: the four compass points, then the diagonals.
const RING = [0, 2, 4, 6, 1, 3, 5, 7].map((k) => (k * Math.PI) / 4);

/**
 * Suggested positions for the panos in `input.scenes` that aren't placed yet.
 * Deterministic: the same input always gives the same output.
 */
export function suggestPositions(input: SuggestInput): SuggestResult {
  // A plan with no usable shape (0, negative, NaN or Infinity) is drawn as a square.
  const ratio =
    input.ratio !== undefined && Number.isFinite(input.ratio) && input.ratio > 0 ? input.ratio : 1;
  const scenes = [...new Set(input.scenes)];
  const inTour = new Set(scenes);
  const empty: SuggestResult = { positions: new Map(), fromLinks: 0, noDirection: 0, unlinked: 0 };

  // Who links to whom (both ways), and the bearing from one to the other where known.
  const neighbours = new Map<string, string[]>(scenes.map((id) => [id, []]));
  const direct = new Map<string, number>();
  for (const l of input.links) {
    if (l.from === l.to || !inTour.has(l.from) || !inTour.has(l.to)) continue;
    const a = neighbours.get(l.from)!;
    const b = neighbours.get(l.to)!;
    if (!a.includes(l.to)) a.push(l.to);
    if (!b.includes(l.from)) b.push(l.from);
    const north = input.north.get(l.from);
    const key = `${l.from}\n${l.to}`;
    if (north !== undefined && !direct.has(key)) direct.set(key, l.yaw - north);
  }
  const bearing = (from: string, to: string): number | null => {
    const own = direct.get(`${from}\n${to}`);
    if (own !== undefined) return own;
    const back = direct.get(`${to}\n${from}`);
    return back === undefined ? null : back + Math.PI;
  };

  const anchors = new Map<string, Pt>();
  for (const id of scenes) {
    const p = input.placed.get(id);
    if (p) anchors.set(id, { u: p.x * ratio, v: p.y });
  }
  const todo = scenes.filter((id) => !anchors.has(id));
  if (todo.length === 0) return empty;

  // With anchors the layout is drawn on the plan itself, at their scale: the mean
  // distance between linked anchors. Without, it is drawn at unit steps and fitted after.
  const onPlan = anchors.size > 0;
  let step = 1;
  if (onPlan) {
    const spans: number[] = [];
    for (const [id, p] of anchors) {
      for (const n of neighbours.get(id)!) {
        const q = anchors.get(n);
        if (q && id < n) spans.push(dist(p, q));
      }
    }
    const mean = spans.length ? spans.reduce((s, d) => s + d, 0) / spans.length : SUGGEST_STEP;
    step = clamp(mean, SUGGEST_GAP * 1.5, 0.35);
  }
  const box = {
    u0: SUGGEST_MARGIN * ratio,
    u1: (1 - SUGGEST_MARGIN) * ratio,
    v0: SUGGEST_MARGIN,
    v1: 1 - SUGGEST_MARGIN,
  };
  const inBox = (p: Pt) => p.u >= box.u0 && p.u <= box.u1 && p.v >= box.v0 && p.v <= box.v1;

  const at = new Map<string, Pt>(anchors);
  const fresh: string[] = [];
  let fromLinks = 0;
  let noDirection = 0;
  let unlinked = 0;

  // The first spot round `centre`, ring by ring, that no dot is near (and, on the plan,
  // that is inside it).
  const freeNear = (centre: Pt): Pt => {
    const taken = [...at.values()];
    for (let r = 1; r <= 12; r++) {
      for (const a of RING) {
        const s = { u: centre.u + r * step * Math.sin(a), v: centre.v - r * step * Math.cos(a) };
        if (onPlan && !inBox(s)) continue;
        if (taken.every((t) => dist(t, s) > step * 0.6)) return s;
      }
    }
    return { ...centre };
  };
  const centroid = (): Pt => {
    const all = [...at.values()];
    if (!all.length) return { u: 0.5 * ratio, v: 0.5 };
    return {
      u: all.reduce((s, p) => s + p.u, 0) / all.length,
      v: all.reduce((s, p) => s + p.v, 0) / all.length,
    };
  };
  const put = (id: string, p: Pt) => {
    at.set(id, p);
    fresh.push(id);
  };

  if (!onPlan) {
    const start = input.start && todo.includes(input.start) ? input.start : todo[0]!;
    put(start, { u: 0, v: 0 });
  }

  while (fresh.length < todo.length) {
    // One ring outwards: every pano with a placed neighbour whose link has a direction,
    // at the mean of where those links put it.
    const ring = new Map<string, Pt>();
    for (const id of todo) {
      if (at.has(id)) continue;
      let su = 0;
      let sv = 0;
      let n = 0;
      for (const nb of neighbours.get(id)!) {
        const p = at.get(nb);
        const b = p && bearing(nb, id);
        if (!p || b === null || b === undefined) continue;
        su += p.u + step * Math.sin(b);
        sv += p.v - step * Math.cos(b);
        n++;
      }
      if (n) ring.set(id, { u: su / n, v: sv / n });
    }
    if (ring.size) {
      for (const [id, p] of ring) put(id, p);
      fromLinks += ring.size;
      continue;
    }
    // None: the first pano linked to a placed one goes beside it, then the first with no
    // placed neighbour at all goes near the middle of the others.
    const linked = todo.find((id) => !at.has(id) && neighbours.get(id)!.some((n) => at.has(n)));
    if (linked) {
      const nb = neighbours.get(linked)!.find((n) => at.has(n))!;
      put(linked, freeNear(at.get(nb)!));
      noDirection++;
      continue;
    }
    const next = todo.find((id) => !at.has(id))!;
    put(next, freeNear(centroid()));
    unlinked++;
  }

  let points = fresh.map((id) => at.get(id)!);
  if (onPlan) {
    points = points.map((p) => ({ u: clamp(p.u, box.u0, box.u1), v: clamp(p.v, box.v0, box.v1) }));
  } else {
    // Into the plan: one link is SUGGEST_STEP long unless the whole lot needs less, and
    // the layout is centred.
    const us = points.map((p) => p.u);
    const vs = points.map((p) => p.v);
    const [minU, maxU, minV, maxV] = [
      Math.min(...us),
      Math.max(...us),
      Math.min(...vs),
      Math.max(...vs),
    ];
    let k = SUGGEST_STEP;
    if (maxU > minU) k = Math.min(k, (box.u1 - box.u0) / (maxU - minU));
    if (maxV > minV) k = Math.min(k, (box.v1 - box.v0) / (maxV - minV));
    const midU = (minU + maxU) / 2;
    const midV = (minV + maxV) / 2;
    points = points.map((p) => ({
      u: clamp(0.5 * ratio + (p.u - midU) * k, box.u0, box.u1),
      v: clamp(0.5 + (p.v - midV) * k, box.v0, box.v1),
    }));
  }

  points = nudgeApart(points, [...anchors.values()], box);

  const positions = new Map<string, MapPoint>();
  fresh.forEach((id, i) => {
    const p = points[i]!;
    positions.set(id, { x: round(p.u / ratio), y: round(p.v) });
  });
  return { positions, fromLinks, noDirection, unlinked };
}

const round = (v: number) => Math.round(clamp(v, 0, 1) * 10_000) / 10_000;

/**
 * Pushes new dots out of each other's way, and out of the fixed ones' way, until each
 * is at least SUGGEST_GAP from the rest (or the passes run out). Fixed dots never move.
 */
function nudgeApart(
  points: Pt[],
  fixed: Pt[],
  box: { u0: number; u1: number; v0: number; v1: number },
): Pt[] {
  const out = points.map((p) => ({ ...p }));
  const keep = (p: Pt) => {
    p.u = clamp(p.u, box.u0, box.u1);
    p.v = clamp(p.v, box.v0, box.v1);
  };
  // Two dots on the same spot part along a direction of their own, never at random.
  const apart = (i: number, j: number): [number, number] => {
    const a = ((i * 7 + j * 3) * TWO_PI) / 16;
    return [Math.sin(a), -Math.cos(a)];
  };
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      const p = out[i]!;
      fixed.forEach((f, j) => {
        const d = dist(p, f);
        if (d >= SUGGEST_GAP) return;
        const [du, dv] = d > 1e-9 ? [(p.u - f.u) / d, (p.v - f.v) / d] : apart(i, j);
        p.u += du * (SUGGEST_GAP - d);
        p.v += dv * (SUGGEST_GAP - d);
        keep(p);
        moved = true;
      });
      for (let j = i + 1; j < out.length; j++) {
        const q = out[j]!;
        const d = dist(p, q);
        if (d >= SUGGEST_GAP) continue;
        const [du, dv] = d > 1e-9 ? [(q.u - p.u) / d, (q.v - p.v) / d] : apart(i, j);
        const half = (SUGGEST_GAP - d) / 2;
        p.u -= du * half;
        p.v -= dv * half;
        q.u += du * half;
        q.v += dv * half;
        keep(p);
        keep(q);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

/** The suggestion for an editor's tour: links and norths from its pano configs. */
export function suggestForTour(docs: EditorDocs, ratio: number): SuggestResult {
  const tour = docs.tour.current;
  const links: SuggestLink[] = [];
  const north = new Map<string, number>();
  for (const { panoId } of tour.scenes) {
    const s = docs.scenes[panoId];
    if (s?.kind !== 'config') continue;
    if (s.current.north !== undefined) north.set(panoId, s.current.north);
    for (const h of s.current.hotspots) {
      if (h.type === 'link' && h.targetPanoId) {
        links.push({ from: panoId, to: h.targetPanoId, yaw: h.yaw });
      }
    }
  }
  return suggestPositions({
    scenes: tour.scenes.map((s) => s.panoId),
    placed: mapPositions(tour),
    links,
    north,
    start: tour.startPanoId,
    ratio,
  });
}
