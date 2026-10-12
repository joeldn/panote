import { describe, it, expect, vi } from 'vitest';
import { anglePerPixel } from './camera-math.js';
import { DEG2RAD } from './render/projection.js';
import {
  useViewerGlobals,
  raf,
  TestViewer,
  internals,
  runUntilIdle,
  canvasListener,
  makeContainer,
} from './test-support/viewer-harness.js';

vi.mock('./render/gl-renderer.js', () => import('./test-support/fake-gl-renderer.js'));

const W = 1422;
const H = 800;

/**
 * A drag replayed as a Mac trackpad sends one: moves at their own rate, with
 * timestamp jitter, landing between display frames at another rate. The
 * pointer moves right at a steady speed from x = 300.
 */
interface Drag {
  /** Pointer speed, px/ms: 0.03 is a slow drag, 1.5 a fast one. */
  v: number;
  displayHz: number;
  inHz?: number;
  /** Whole-pixel coordinates, as some browsers report them. */
  int?: boolean;
  /** Timestamp jitter, ms either way. */
  jitterMs?: number;
  /** Sensor noise on each move, px either way. */
  noisePx?: number;
  dragMs?: number;
  /** The pointer holds still this long at the middle of the drag, ms. */
  restMs?: number;
  inertia?: boolean;
}

interface Replay {
  /** The camera's travel on each drag frame, screen px. */
  steps: number[];
  /** The same from 100 ms in, once the drag is under way. */
  steady: number[];
  /** How far the camera trails the pointer on those frames, ms of pointer motion. */
  lagMs: number[];
  /** The camera's travel on each glide frame after the release, px. */
  glide: number[];
  /** The drag's speed on screen over its last 100 ms, px per frame. */
  dragSpeed: number;
  /** The pointer's travel and the camera's once it has settled, px. */
  pointerPx: number;
  settledPx: number;
}

/** A small seeded generator, so a replay is the same every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function replay(d: Drag): Replay {
  const viewer = new TestViewer(makeContainer(W, H), { interaction: { inertia: d.inertia } });
  runUntilIdle();
  const rig = internals(viewer).rig;
  const vfov = (viewer as unknown as { rig: { effectiveVFovDeg(f: number): number } }).rig;
  const vfovRad = vfov.effectiveVFovDeg(rig.view.fov) * DEG2RAD;
  const pxPerRad = 1 / anglePerPixel(2 * Math.atan(Math.tan(vfovRad / 2) * (W / H)), W);
  const period = 1000 / d.displayHz;
  const dragMs = d.dragMs ?? 1200;
  const restMs = d.restMs ?? 0;
  const rnd = lcg(12345);
  // The drag starts between frames.
  const t0 = Math.ceil(raf.now / period) * period + period * 0.37;
  const moves: { t: number; x: number }[] = [];
  const inPeriod = 1000 / (d.inHz ?? 90);
  for (let i = 1; i * inPeriod <= dragMs; i++) {
    const at = i * inPeriod + (rnd() * 2 - 1) * (d.jitterMs ?? 1.5);
    // The rest, from the middle on, delays the moves without moving them.
    const t = t0 + (at < dragMs / 2 ? at : at + restMs);
    const x = 300 + d.v * at + (rnd() * 2 - 1) * (d.noisePx ?? 0);
    moves.push({ t, x: d.int ? Math.round(x) : x });
  }
  moves.sort((a, b) => a.t - b.t);
  const ev = (x: number, t: number, buttons = 1) => ({
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons,
    clientX: x,
    clientY: 400,
    timeStamp: t,
  });
  raf.now = t0;
  canvasListener(viewer, 'pointerdown')(ev(300, t0));
  const yaw0 = rig.view.yaw;
  const shown = () => -(rig.view.yaw - yaw0) * pxPerRad;
  const frames: { t: number; px: number }[] = [];
  const last = moves[moves.length - 1]!;
  let k = 0;
  const moveUntil = (until: number) => {
    for (; k < moves.length && moves[k]!.t <= until; k++) {
      raf.now = moves[k]!.t;
      canvasListener(viewer, 'pointermove')(ev(moves[k]!.x, moves[k]!.t));
    }
  };
  let t = Math.ceil(t0 / period) * period;
  for (; t <= last.t; t += period) {
    moveUntil(t);
    raf.step(t);
    frames.push({ t, px: shown() });
  }
  moveUntil(last.t);
  const steps = frames.slice(1).map((f, i) => f.px - frames[i]!.px);
  const steady = steps.filter((_, i) => frames[i]!.t - t0 >= 100);
  const lagMs = frames.filter((f) => f.t - t0 >= 100).map((f) => (d.v * (f.t - t0) - f.px) / d.v);
  const tail = frames.filter((f) => f.t >= frames[frames.length - 1]!.t - 100);
  const dragSpeed = (tail[tail.length - 1]!.px - tail[0]!.px) / (tail.length - 1);

  // Let go just after the last move, still moving.
  raf.now = last.t + 4;
  canvasListener(viewer, 'pointerup')(ev(last.x, last.t + 4, 0));
  const glide: number[] = [];
  let prev = shown();
  // `t` is already the frame after the drag's last.
  for (; raf.pending > 0 && glide.length < 2000; t += period) {
    raf.step(t);
    glide.push(shown() - prev);
    prev = shown();
  }
  viewer.dispose();
  return { steps, steady, lagMs, glide, dragSpeed, pointerPx: last.x - 300, settledPx: prev };
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
/** Coefficient of variation: the spread of the steps against their size. */
const cv = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) / Math.abs(m);
};
/** The longest run of steps under `min` px. */
const longestStill = (a: number[], min: number) => {
  let run = 0;
  let longest = 0;
  for (const x of a) {
    run = x < min ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
};

/** The glide's first frame carries on at the drag's speed, then only slows. */
function expectSteadyGlide({ glide, dragSpeed }: Replay): void {
  expect(glide.length).toBeGreaterThan(20);
  expect(glide[0]! / dragSpeed).toBeGreaterThanOrEqual(0.8);
  expect(glide[0]! / dragSpeed).toBeLessThan(1.4);
  for (let i = 1; i < glide.length; i++) expect(glide[i]!).toBeLessThanOrEqual(glide[i - 1]!);
}

describe('PanoViewer: drag smoothness', () => {
  useViewerGlobals();

  describe.each([60, 120])('on a %d Hz display, with 90 Hz input', (displayHz) => {
    const ideal = (v: number) => v * (1000 / displayHz);

    it('moves a slow drag evenly, every frame', () => {
      // 0.03 px/ms with ±1.5 ms jitter, fractional coordinates and ±0.15 px
      // of sensor noise: on arrival, a step CV of 0.39 at 60 Hz and 0.71 at
      // 120 Hz, where a third of the frames didn't move.
      const r = replay({ v: 0.03, displayHz, noisePx: 0.15 });
      expect(cv(r.steady)).toBeLessThan(0.2);
      expect(Math.min(...r.steady)).toBeGreaterThan(ideal(0.03) * 0.5);
      // Smoothing a drag this slow costs about 30 ms: under a pixel.
      expect(Math.max(...r.lagMs)).toBeLessThan(40);
    });

    it('moves a slow drag in whole pixels without standing still', () => {
      // A pixel every 33 ms: on arrival, a frame in two (60 Hz) or three in
      // four (120 Hz) didn't move.
      const r = replay({ v: 0.03, displayHz, int: true });
      expect(longestStill(r.steady, ideal(0.03) * 0.25)).toBe(0);
      expect(cv(r.steady)).toBeLessThan(0.4);
    });

    it.each([
      ['medium', 0.3, 30],
      ['fast', 1.5, 20],
    ])('moves a %s drag evenly, close behind the pointer', (_, v, maxLagMs) => {
      for (const int of [false, true]) {
        const r = replay({ v, displayHz, int, noisePx: int ? 0 : 0.15 });
        expect(cv(r.steady)).toBeLessThan(0.1);
        expect(Math.min(...r.steady)).toBeGreaterThan(ideal(v) * 0.8);
        expect(Math.max(...r.lagMs)).toBeLessThan(maxLagMs);
      }
    });

    it('starts, and sets off again after a rest, without a jump', () => {
      const r = replay({ v: 0.3, displayHz, restMs: 300 });
      // Never a step bigger than the drag's own, though the camera trails
      // the pointer and the first move after the rest covers more than a
      // frame's worth.
      for (const step of r.steps) expect(step).toBeLessThan(ideal(0.3) * 1.25);
      expect(r.steps[0]!).toBeLessThan(ideal(0.3) * 0.5);
    });

    it.each([
      ['slow', 0.03],
      ['medium', 0.3],
      ['fast', 1.5],
    ])('glides a released %s drag on at its speed, then slows', (_, v) => {
      expectSteadyGlide(replay({ v, displayHz, noisePx: 0.15 }));
    });

    it('lands where the pointer let go, with inertia off', () => {
      const r = replay({ v: 0.3, displayHz, inertia: false });
      expect(r.settledPx).toBeCloseTo(r.pointerPx, 2);
      // Easing in what it had yet to draw: slowing from the drag's speed,
      // until the last frame snaps it onto the target.
      expect(r.glide[0]! / r.dragSpeed).toBeLessThan(1);
      for (let i = 1; i < r.glide.length - 1; i++) {
        expect(r.glide[i]!).toBeLessThanOrEqual(r.glide[i - 1]!);
      }
    });
  });

  it('glides a released drag as far as the pointer went plus its fling', () => {
    const flung = replay({ v: 0.3, displayHz: 60 });
    const held = replay({ v: 0.3, displayHz: 60, inertia: false });
    // A fling from 0.3 px/ms travels 5 px per frame / (1 − 0.9).
    expect(flung.settledPx - held.settledPx).toBeCloseTo(50, -1);
  });
});
