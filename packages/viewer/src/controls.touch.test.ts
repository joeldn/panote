import { describe, it, expect, beforeEach, onTestFinished, vi } from 'vitest';
import { Controls, PINCH_ARM_MS } from './controls.js';
import { resolveViewerOptions } from './defaults.js';
import { viewProjection, unprojectNDC } from './render/projection.js';
import { VIEWER_DEFAULTS } from './defaults.js';
import { dirFromYawPitch } from './test-support/oracles.js';
import { makeRig, frameClock, rigInternals } from './test-support/rig.js';
import type { CameraRig } from './camera-rig.js';
import type { InteractionOptions } from './types.js';

/**
 * Touch input replayed as iOS Safari sends it, through Controls into a real
 * CameraRig stepped by a frame clock: each finger is a pointerdown, moves and
 * a pointerup (or pointercancel), followed by the touch event for it; a
 * second finger adds gesturestart/gesturechange/gestureend, which on iOS
 * carry a scale but no coordinates; and a double tap may end in a dblclick.
 */

const W = 390;
const H = 844;
const { maxHorizontalFov: MAX_H } = VIEWER_DEFAULTS.camera;

type Listener = (e: unknown) => void;

class FakeElement {
  style: Record<string, string> = {};
  tabIndex = -1;
  listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: W, height: H };
  }
  get clientHeight() {
    return H;
  }
  dispatch(type: string, init: object) {
    const ev = { type, defaultPrevented: false, preventDefault() {}, ...init };
    ev.preventDefault = () => {
      ev.defaultPrevented = true;
    };
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    return ev;
  }
}

let el: FakeElement;
let rig: CameraRig;
let frame: (t: number) => boolean;
// Fingers on the screen, by pointer id, for the touch events' `touches`.
let down: Map<number, { x: number; y: number }>;
// The last frame drawn, ms.
let drawnTo: number;

function setup(opts: InteractionOptions = {}) {
  el = new FakeElement();
  ({ rig } = makeRig(W, H, { initialView: { yaw: 0.3, pitch: 0.1, fov: 70 } }));
  frame = frameClock(rig);
  down = new Map();
  drawnTo = 0;
  const { interaction } = resolveViewerOptions({ interaction: opts });
  return new Controls(el as unknown as HTMLElement, rig, interaction);
}

/** Draw 60 Hz frames up to `t`. */
function drawTo(t: number) {
  for (let f = drawnTo + 1000 / 60; f <= t; f += 1000 / 60) {
    frame(f);
    drawnTo = f;
  }
}

function pointer(type: string, id: number, x: number, y: number, t: number) {
  drawTo(t);
  return el.dispatch(type, {
    pointerId: id,
    pointerType: 'touch',
    // A touch is primary when it lands on an empty screen.
    isPrimary: type === 'pointerdown' ? down.size === 0 : id === primaryId,
    button: 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    clientX: x,
    clientY: y,
    timeStamp: t,
  });
}

let primaryId = -1;

function touchEvent(type: string) {
  el.dispatch(type, { touches: { length: down.size } });
}

function fingerDown(id: number, x: number, y: number, t: number) {
  if (down.size === 0) primaryId = id;
  pointer('pointerdown', id, x, y, t);
  down.set(id, { x, y });
  touchEvent('touchstart');
}

function fingerMove(id: number, x: number, y: number, t: number) {
  pointer('pointermove', id, x, y, t);
  down.set(id, { x, y });
  touchEvent('touchmove');
}

/**
 * The finger lifts; `lost` drops its pointerup, as a missed one would be.
 * The pointerup comes before the touchend, or after it with `touchFirst`.
 */
function fingerUp(id: number, t: number, how: 'up' | 'cancel' | 'lost' = 'up', touchFirst = false) {
  const at = down.get(id)!;
  down.delete(id);
  const touch = () => touchEvent(how === 'cancel' ? 'touchcancel' : 'touchend');
  if (touchFirst) touch();
  if (how !== 'lost') pointer(how === 'up' ? 'pointerup' : 'pointercancel', id, at.x, at.y, t);
  if (!touchFirst) touch();
}

/** One finger from (x, y) by (dx, dy) over `ms`, a move every 16 ms. */
function swipe(
  id: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  t: number,
  ms: number,
  touchFirst = false,
) {
  fingerDown(id, x, y, t);
  const n = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) fingerMove(id, x + (dx * i) / n, y + (dy * i) / n, t + (ms * i) / n);
  fingerUp(id, t + ms + 4, 'up', touchFirst);
  return t + ms + 4;
}

/** A pinch from `gap` px apart to `gap * spread` about (cx, cy), with the iOS gesture events. */
function pinch(
  ids: [number, number],
  cx: number,
  cy: number,
  gap: number,
  spread: number,
  t: number,
  opts: { end?: 'up' | 'lost' | 'cancel'; pan?: [number, number] } = {},
) {
  const [a, b] = ids;
  const [px, py] = opts.pan ?? [0, 0];
  fingerDown(a, cx - gap / 2, cy, t);
  fingerDown(b, cx + gap / 2, cy, t + 8);
  el.dispatch('gesturestart', { scale: 1, rotation: 0 });
  // The fingers settle for the pinch delay, then move.
  for (let i = 1; i <= 10; i++) {
    const g = (gap * (1 + ((spread - 1) * i) / 10)) / 2;
    const mx = cx + (px * i) / 10;
    const my = cy + (py * i) / 10;
    const ti = t + 8 + PINCH_ARM_MS + (i - 1) * 16;
    fingerMove(a, mx - g, my, ti);
    el.dispatch('gesturechange', { scale: 1 + ((spread - 1) * i) / 10, rotation: 0 });
    fingerMove(b, mx + g, my, ti + 1);
  }
  const end = t + 8 + PINCH_ARM_MS + 9 * 16 + 10;
  fingerUp(a, end, opts.end === 'cancel' ? 'cancel' : 'up');
  el.dispatch('gestureend', { scale: spread, rotation: 0 });
  fingerUp(b, end + 2, opts.end ?? 'up');
  return end + 2;
}

/** The scene direction at client (x, y), as the camera is drawn. */
function directionAt(x: number, y: number) {
  const vp = viewProjection(rig.view, rig.aspect, MAX_H);
  const v = unprojectNDC((x / W) * 2 - 1, -((y / H) * 2 - 1), vp);
  return dirFromYawPitch(Math.atan2(v.x, -v.z), Math.asin(Math.max(-1, Math.min(1, v.y))));
}

function angleBetween(u: ReturnType<typeof directionAt>, v: ReturnType<typeof directionAt>) {
  return Math.acos(Math.min(1, Math.max(-1, u.x * v.x + u.y * v.y + u.z * v.z)));
}

describe('Controls with a CameraRig: one-finger touch never zooms (iOS Safari)', () => {
  beforeEach(() => {
    setup();
  });

  it('keeps the fov through a slow one-finger drag', () => {
    const t = swipe(1, 100, 400, 200, 80, 0, 600);
    drawTo(t + 1500);
    expect(rig.view.fov).toBe(70);
    expect(rig.view.yaw).not.toBeCloseTo(0.3, 2);
  });

  it('keeps the fov through fast flicks, one straight after another', () => {
    let t = 0;
    for (let i = 0; i < 6; i++) t = swipe(10 + i, 80, 400, 260, (i % 3) * 30, t + 30, 60);
    drawTo(t + 1500);
    expect(rig.view.fov).toBe(70);
  });

  it('keeps the fov when a quick touch lands before the last one reported lifting', () => {
    // A flick whose pointerup arrives only after the next finger is down.
    fingerDown(1, 100, 400, 0);
    fingerMove(1, 250, 400, 40);
    down.delete(1);
    touchEvent('touchend');
    fingerDown(2, 120, 420, 70);
    fingerMove(2, 200, 425, 86);
    pointer('pointerup', 1, 250, 400, 90);
    fingerMove(2, 300, 430, 100);
    fingerMove(2, 360, 430, 116);
    // The second finger's own flick still glides.
    fingerUp(2, 120);
    expect(rigInternals(rig).momentum.yaw).not.toBe(0);
    drawTo(1500);
    expect(rig.view.fov).toBe(70);
  });

  it('keeps the fov when the next flick lands while the last finger is still lifting', () => {
    // Two fingers flicking in turn: the second is down for 40 ms before the
    // first lifts, both moving fast and close together.
    fingerDown(1, 100, 400, 0);
    fingerMove(1, 180, 400, 16);
    fingerMove(1, 260, 400, 32);
    fingerDown(2, 150, 410, 40);
    fingerMove(1, 300, 400, 48);
    fingerMove(2, 210, 410, 56);
    fingerMove(1, 320, 400, 64);
    fingerMove(2, 270, 410, 72);
    fingerUp(1, 80);
    fingerMove(2, 330, 410, 88);
    fingerMove(2, 390, 410, 104);
    fingerUp(2, 108);
    drawTo(1500);
    expect(rig.view.fov).toBe(70);
    expect(rig.view.yaw).not.toBeCloseTo(0.3, 2);
  });

  it('drags without zooming after a pinch whose last pointerup was lost', () => {
    let t = pinch([1, 2], 195, 420, 100, 2, 0, { end: 'lost' });
    expect(rig.view.fov).toBeLessThan(70);
    const fov = rig.view.fov;
    t = swipe(3, 100, 300, 220, 0, t + 300, 300);
    t = swipe(4, 300, 500, -180, 60, t + 300, 80);
    drawTo(t + 1500);
    expect(rig.view.fov).toBe(fov);
  });

  it('drags without zooming after a pinch whose gestureend was lost', () => {
    fingerDown(1, 145, 420, 0);
    fingerDown(2, 245, 420, 8);
    el.dispatch('gesturestart', { scale: 1, rotation: 0 });
    fingerMove(2, 295, 420, 70);
    el.dispatch('gesturechange', { scale: 1.5, rotation: 0 });
    fingerUp(1, 90);
    fingerUp(2, 92);
    const fov = rig.view.fov;
    const t = swipe(3, 100, 300, 220, 0, 400, 200);
    // A stray gesturechange with no gesture under way scales nothing.
    el.dispatch('gesturechange', { scale: 0.5, rotation: 0 });
    drawTo(t + 1500);
    expect(rig.view.fov).toBe(fov);
  });

  it('drags without zooming after a pinch cancelled mid-gesture', () => {
    let t = pinch([1, 2], 195, 420, 100, 1.6, 0, { end: 'cancel' });
    const fov = rig.view.fov;
    t = swipe(3, 100, 300, 220, 0, t + 300, 200);
    drawTo(t + 1500);
    expect(rig.view.fov).toBe(fov);
  });

  it('applies no centre zoom from gesture events once the pinch pointers are cancelled', () => {
    fingerDown(1, 145, 420, 0);
    fingerDown(2, 245, 420, 8);
    // The browser takes the touches over before its gesture starts; the
    // fingers stay down.
    pointer('pointercancel', 1, 145, 420, 20);
    pointer('pointercancel', 2, 245, 420, 20);
    const start = el.dispatch('gesturestart', { scale: 1, rotation: 0 });
    const change = el.dispatch('gesturechange', { scale: 2, rotation: 0 });
    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(rig.view.fov).toBe(70);
  });

  it("glides the same whether a flick's touchend comes before or after its pointerup", () => {
    const glide = (touchFirst: boolean) => {
      setup();
      const t = swipe(1, 80, 400, 240, 40, 0, 96, touchFirst);
      const momentum = { ...rigInternals(rig).momentum };
      drawTo(t + 1500);
      return { momentum, view: { ...rig.view } };
    };
    const pointerFirst = glide(false);
    expect(pointerFirst.momentum.yaw).not.toBe(0);
    expect(glide(true)).toEqual(pointerFirst);
  });

  it('zooms on a double tap whose touchends come before their pointerups', () => {
    const t = swipe(1, 200, 400, 2, 1, 0, 30, true);
    swipe(2, 201, 401, 1, 0, t + 80, 30, true);
    el.dispatch('dblclick', { clientX: 201, clientY: 401 });
    expect(rig.view.fov).toBeCloseTo(70 * VIEWER_DEFAULTS.interaction.doubleClickZoom, 6);
  });

  it('forgets a finger whose pointerup never comes, shortly after its touchend', () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    fingerDown(1, 100, 400, 0);
    fingerMove(1, 200, 400, 16);
    fingerUp(1, 20, 'lost');
    expect(el.style['cursor']).toBe('grabbing');
    vi.advanceTimersByTime(100);
    expect(el.style['cursor']).toBe('grab');
    // A late pointerup then finds nothing to release.
    pointer('pointerup', 1, 200, 400, 200);
    expect(rigInternals(rig).momentum).toEqual({ yaw: 0, pitch: 0 });
  });

  it('zooms on a double tap, but not on two quick swipes', () => {
    let t = swipe(1, 100, 400, 120, 0, 0, 50);
    t = swipe(2, 110, 400, 120, 0, t + 60, 50);
    el.dispatch('dblclick', { clientX: 230, clientY: 400 });
    expect(rig.view.fov).toBe(70);
    // Two taps that stay put: the double tap zooms toward the point.
    t = swipe(3, 200, 400, 2, 1, t + 400, 30);
    swipe(4, 201, 401, 1, 0, t + 80, 30);
    el.dispatch('dblclick', { clientX: 201, clientY: 401 });
    expect(rig.view.fov).toBeCloseTo(70 * VIEWER_DEFAULTS.interaction.doubleClickZoom, 6);
  });
});

describe('Controls with a CameraRig: a two-finger pinch zooms about the fingers (iOS Safari)', () => {
  beforeEach(() => {
    setup();
  });

  it.each([
    { name: 'off centre, spreading', cx: 290, cy: 260, gap: 90, spread: 2.2, pan: [0, 0] },
    { name: 'low, pinching in', cx: 110, cy: 640, gap: 220, spread: 0.6, pan: [0, 0] },
    { name: 'moving while it spreads', cx: 120, cy: 300, gap: 80, spread: 1.8, pan: [90, 140] },
  ] as const)(
    'keeps the scene under the midpoint under it: $name',
    ({ cx, cy, gap, spread, pan }) => {
      const anchor = directionAt(cx, cy);
      const t = pinch([1, 2], cx, cy, gap, spread, 0, { pan: [pan[0], pan[1]] });
      drawTo(t + 1500);
      const end = { x: cx + pan[0], y: cy + pan[1] };
      expect(angleBetween(directionAt(end.x, end.y), anchor)).toBeLessThan(1e-4);
      expect(rig.view.fov).not.toBeCloseTo(70, 0);
    },
  );

  it('zooms once per pinch, by the fingers, whatever the gesture scale says', () => {
    pinch([1, 2], 195, 420, 100, 2, 0);
    // Spread to twice the distance: half the fov, from the pointers alone.
    expect(rig.view.fov).toBeCloseTo(35, 6);
  });

  it('pinches about the fingers after a pinch whose pointerup was lost', () => {
    const t = pinch([1, 2], 195, 420, 100, 1.5, 0, { end: 'lost' });
    const fov = rig.view.fov;
    const anchor = directionAt(300, 250);
    pinch([3, 4], 300, 250, 80, 2, t + 400);
    expect(rig.view.fov).toBeCloseTo(fov / 2, 6);
    expect(angleBetween(directionAt(300, 250), anchor)).toBeLessThan(1e-4);
  });
});
