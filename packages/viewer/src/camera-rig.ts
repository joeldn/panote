import { DEG2RAD, effectiveVFovDeg, maxVFovDeg } from './render/projection.js';
import {
  TAU,
  clamp,
  damp,
  anglePerPixel,
  zoomAnchorView,
  rayAt,
  aimRay,
  type Tangents,
  type YawPitch,
  compassHeading,
  normalizeAngle,
} from './camera-math.js';
import type { ControlHost } from './controls.js';
import type { ResolvedViewerOptions, View } from './types.js';

// damping and momentumFriction are per 60 Hz frame; motion is scaled to the
// real frame time so it feels the same at 30, 60 and 120 Hz.
export const FRAME_MS = 1000 / 60;
// A stalled or backgrounded tab must not spend its whole absence as one jump on resume.
export const MAX_FRAME_DT_MS = 100;
// Momentum below this (rad/ms) is stopped: 1e-5 rad per 60 Hz frame.
const MOMENTUM_EPS = 1e-5 / FRAME_MS;
// The most friction a glide that takes over a drag's leftover can have (see
// flick): a drag released with almost no speed eases its leftover in over
// about half a second rather than creeping on.
export const GLIDE_FRICTION_MAX = 0.97;

// A drag is drawn where the pointer was a moment ago, interpolated between
// its timestamped moves, not where the newest move left it. Moves come at
// the input rate (about 90 Hz from a Mac trackpad, with jitter) and frames
// at the display rate, so a camera moved on each arrival steps unevenly from
// frame to frame and some frames don't move at all. The lag is one input
// period, measured from the moves, plus DRAG_JITTER_MS, so a frame nearly
// always falls between two moves: 13 ms behind at 90 Hz input, 10 ms at
// 120 Hz, never more than DRAG_LAG_MAX_MS. With the filter below, a 90 Hz
// drag is drawn about 15 ms behind the pointer when fast, 20 ms at medium
// speed and 30 ms when slow (under a pixel at 0.03 px/ms), against 6 or 7 ms
// when each move was applied as it came.
const DRAG_JITTER_MS = 2;
const DRAG_LAG_MAX_MS = 20;
// The input period assumed until a drag's moves measure it, and how much of
// each gap between moves goes into the measure: about the last five.
const DRAG_PERIOD_MS = 1000 / 90;
const DRAG_PERIOD_GAIN = 0.2;
// A gap between moves longer than this is a rest, not the input period: the
// move after it is taken to have started one 60 Hz frame before it came,
// rather than to have crept along through the whole rest. Coarse timestamps
// (Firefox's resistFingerprinting rounds them) make rests harder to tell.
const DRAG_REST_MS = 50;
// Drag samples kept: 20 ms of 240 Hz input is 5, with headroom for a stall.
const DRAG_SAMPLES = 16;
// The interpolated pointer then passes through a one-euro filter (Casiez et
// al., 2012): a low-pass whose cutoff rises with speed. A slow drag, where
// whole-pixel coordinates and sensor noise are as big as a frame's motion,
// is smoothed over about 20 ms (8 Hz); a fast one barely at all (98 Hz at
// 1.5 px/ms), so it keeps up.
const DRAG_MIN_CUTOFF_HZ = 8;
// Cutoff gained per px/ms of drag speed.
const DRAG_BETA = 60;
// Cutoff for the speed estimate that sets the cutoff.
const DRAG_SPEED_CUTOFF_HZ = 1;
// A drag closer than this (px) to its newest move has caught up.
const DRAG_SETTLE_PX = 0.01;

/** One-euro smoothing factor for a cutoff of `hz` over `dt` ms. */
function smoothing(hz: number, dt: number): number {
  return 1 / (1 + 1000 / (TAU * hz * dt));
}

/** `yaw` less its whole turns: the same rendered angle, kept within ±2π. */
function unwound(yaw: number): number {
  return yaw - Math.trunc(yaw / TAU) * TAU;
}

// Scratch for the zoom and pinch solvers, which run synchronously: the
// pointer as tangents before and after a zoom step, and a pinch midpoint.
const tanBefore: Tangents = { x: 0, y: 0 };
const tanAfter: Tangents = { x: 0, y: 0 };
const pinchPoint: Tangents = { x: 0, y: 0 };

/** The screen point `ndc` as tangents, for a vertical fov of `vfovDeg` at `aspect`. */
function pointTangents(
  ndc: { x: number; y: number },
  vfovDeg: number,
  aspect: number,
  out: Tangents,
): Tangents {
  const ty = Math.tan((vfovDeg * DEG2RAD) / 2);
  out.x = ndc.x * (ty * aspect);
  out.y = ndc.y * ty;
  return out;
}

/** A pointer in client coordinates as NDC (−1..1, y up); may reuse its result. */
export type ToNdc = (clientX: number, clientY: number) => { x: number; y: number };

/**
 * The camera: where it is drawn (`view`), where it is heading (the target),
 * and what moves it there — drags, keys, flings, zoom and pinch, auto-rotate
 * and damping. It is the Controls' host. DOM-free: pointers are mapped to
 * NDC by the `toNdc` it is given, and time arrives through step(), so it
 * runs without a canvas or a frame loop.
 */
export class CameraRig implements ControlHost {
  /** The camera as drawn: rewritten in place as it moves. Read it, don't write it. */
  readonly view: View;
  private target: View;
  // Release inertia, in rad/ms. A glide moves the view and the target together.
  private momentum = { yaw: 0, pitch: 0 };
  // The friction the glide in progress decays by, per 60 Hz frame: the
  // camera's, or a little less for one that carries a drag's leftover on.
  private glideFriction: number;
  // The drag in progress: the pointer's offset in px from where it started,
  // at each of its recent moves (a ring buffer), and the offset already
  // applied to the camera. step() moves the camera along it.
  private dragging = false;
  private dragT = new Float64Array(DRAG_SAMPLES);
  private dragX = new Float64Array(DRAG_SAMPLES);
  private dragY = new Float64Array(DRAG_SAMPLES);
  private dragCount = 0;
  private dragHead = 0;
  private dragPeriod = DRAG_PERIOD_MS;
  private dragAppliedX = 0;
  private dragAppliedY = 0;
  // The one-euro filter: the pointer offset sampled on the last frame, its
  // smoothed speed (px/ms) and when that frame was; undefined until the
  // drag's first frame. Moves stamped more than a second ahead of the frame
  // clock are on another clock, and dragClockShift lines the two up.
  private dragRawX = 0;
  private dragRawY = 0;
  private dragSpeedX = 0;
  private dragSpeedY = 0;
  private dragFrameT: number | undefined;
  private dragClockShift = 0;
  // What dragEnd() last added to the target (rad), for a flick to take over.
  private dragLeft = { yaw: 0, pitch: 0 };
  // The container's CSS size, never 0, and width over height of the last
  // container that had both. Set through setViewport(); read, don't write.
  cssW = 1;
  cssH = 1;
  aspect = 1;
  // zoomAt's solved view, reused so a wheel or pinch event allocates nothing.
  private zoomScratch: YawPitch = { yaw: 0, pitch: 0 };
  // A pinch is solved from where it started, not event by event: the scene
  // direction under the fingers then, and the fov then.
  private pinchRay: YawPitch = { yaw: 0, pitch: 0 };
  private pinchFov = 0;
  private north: number;
  // autoRotate.enabled as setAutoRotate() last set it.
  private autoRotateEnabled: boolean;
  // Whether auto-rotate is actually turning this frame — false while a
  // recent interaction's idle timer hasn't elapsed yet.
  private autoRotateActive: boolean;
  private autoRotateResumeTimer: ReturnType<typeof setTimeout> | undefined;
  // Last frame auto-rotate advanced yaw on; undefined whenever it isn't
  // running, so the frame it (re)starts on applies zero elapsed time.
  private autoRotateLastFrame: number | undefined;

  /**
   * `invalidate` is called whenever the camera needs a frame to show a change:
   * an input, a programmatic move, auto-rotate switched on or resuming.
   */
  constructor(
    private camera: ResolvedViewerOptions['camera'],
    private autoRotate: ResolvedViewerOptions['autoRotate'],
    initial: Partial<View> | undefined,
    private invalidate: () => void,
    private toNdc: ToNdc,
  ) {
    this.north = camera.north;
    this.glideFriction = camera.momentumFriction;
    this.autoRotateEnabled = autoRotate.enabled;
    // No interaction has happened yet, so an enabled auto-rotate starts turning right away.
    this.autoRotateActive = this.autoRotateEnabled;
    // Clamped like setView: an embed config can say anything, and an
    // unclamped pitch past ±π/2 reaches viewProjection as a mirrored view.
    this.view = {
      yaw: initial?.yaw ?? 0,
      pitch: this.clampPitch(initial?.pitch ?? 0),
      fov: this.clampFov(initial?.fov ?? camera.defaultFov),
    };
    this.target = { ...this.view };
  }

  /** The container is now `width` × `height` CSS pixels. */
  setViewport(width: number, height: number): void {
    this.cssW = width || 1;
    this.cssH = height || 1;
    // A zero-size container (hidden, mid-layout) has no aspect: keep the
    // last real one rather than make one up from a stand-in size.
    if (width > 0 && height > 0) this.aspect = width / height;
  }

  /** Set the compass north offset (radians). */
  setNorth(radians: number): void {
    this.north = radians;
  }

  /** Current compass heading (radians): north relative to the rendered yaw. */
  heading(): number {
    return compassHeading(this.view.yaw, this.north);
  }

  /** Enable or disable idle auto-rotate; interaction still pauses it. */
  setAutoRotate(enabled: boolean): void {
    this.autoRotateEnabled = enabled;
    clearTimeout(this.autoRotateResumeTimer);
    this.autoRotateResumeTimer = undefined;
    this.autoRotateActive = enabled;
    this.invalidate();
  }

  // Pause auto-rotate immediately and arm a timer to resume it once the
  // configured idle window passes with no further interaction.
  private pauseAutoRotate(): void {
    if (!this.autoRotateEnabled) return;
    this.autoRotateActive = false;
    clearTimeout(this.autoRotateResumeTimer);
    this.autoRotateResumeTimer = setTimeout(() => {
      this.autoRotateActive = true;
      this.invalidate();
    }, this.autoRotate.idleMs);
  }

  /** Whether auto-rotate turns the camera on the next step. */
  autoRotating(): boolean {
    // A zero speed turns nothing, so it must not keep the loop running.
    return this.autoRotateEnabled && this.autoRotateActive && this.autoRotate.speed !== 0;
  }

  /** Start auto-rotate's clock afresh: the next step turns by nothing. */
  restartAutoRotateClock(): void {
    this.autoRotateLastFrame = undefined;
  }

  /** The vertical fov drawn for a requested `requestedDeg` at this aspect. */
  effectiveVFovDeg(requestedDeg: number): number {
    return effectiveVFovDeg(requestedDeg, this.camera.maxHorizontalFov, this.aspect);
  }

  clampPitch(pitch: number): number {
    return clamp(pitch, this.camera.minPitch, this.camera.maxPitch);
  }

  /**
   * `fov` within camera.minFov/maxFov. Independent of the aspect, so a
   * requested fov survives a rotation, a resize or a zero-size blip.
   */
  clampFov(fov: number): number {
    return clamp(fov, this.camera.minFov, this.camera.maxFov);
  }

  /**
   * A user zoom step: `factor` applied to the fov drawn, not the one
   * requested, and kept within what this aspect can draw. Above the
   * horizontal fov cap a requested fov draws the same picture, so a step
   * taken from it could change nothing on screen. Zooming out stops at the
   * cap, which the user then has chosen.
   */
  private zoomStep(fromDeg: number, factor: number): number {
    const { minFov, maxFov, maxHorizontalFov } = this.camera;
    const cap = maxVFovDeg(maxHorizontalFov, this.aspect);
    const max = Math.max(minFov, Math.min(maxFov, cap));
    return clamp(Math.min(fromDeg, cap) * factor, minFov, max);
  }

  /**
   * The camera a scene arriving now with `view` will have: the target, with
   * `view`'s axes applied as cutTo() will apply them.
   */
  arrival(view: Partial<View> | undefined): View {
    const t = this.target;
    return {
      yaw: view?.yaw ?? t.yaw,
      pitch: view?.pitch === undefined ? t.pitch : this.clampPitch(view.pitch),
      fov: view?.fov === undefined ? t.fov : this.clampFov(view.fov),
    };
  }

  /**
   * Move the camera to `view` at once, with no easing: a scene's own view.
   * Only the axes it sets are cut; any other axis keeps easing as it was.
   * A glide stops either way, as it does for setView().
   */
  cutTo(view: Partial<View> = {}): void {
    this.setView(view);
    if (view.yaw !== undefined) this.view.yaw = this.target.yaw;
    if (view.pitch !== undefined) this.view.pitch = this.target.pitch;
    if (view.fov !== undefined) this.view.fov = this.target.fov;
  }

  /** Horizontal fov (rad) for a vertical one at the current aspect. */
  private hfovOf(vfov: number): number {
    return 2 * Math.atan(Math.tan(vfov / 2) * this.aspect);
  }

  /** Move the camera now, by a wheel swipe: no easing and no resampling. */
  panByPixels(dx: number, dy: number): void {
    this.pauseAutoRotate();
    this.pan(dx, dy);
    this.invalidate();
  }

  // Move view and target together by (dx, dy) px of pointer motion.
  private pan(dx: number, dy: number): void {
    const vfov = this.effectiveVFovDeg(this.view.fov) * DEG2RAD;
    const hfov = this.hfovOf(vfov);
    // drag right → look left
    const yaw = unwound(this.view.yaw - dx * anglePerPixel(hfov, this.cssW));
    const pitch = this.clampPitch(this.view.pitch + dy * anglePerPixel(vfov, this.cssH));
    this.view.yaw = yaw;
    this.target.yaw = yaw;
    this.view.pitch = pitch;
    this.target.pitch = pitch;
  }

  // panByPixels for the keyboard: moves only the target, so step()'s
  // damping eases the camera after it and key repeat glides.
  panTargetByPixels(dx: number, dy: number): void {
    this.pauseAutoRotate();
    this.panTarget(dx, dy);
    this.invalidate();
  }

  private panTarget(dx: number, dy: number): void {
    const vfov = this.effectiveVFovDeg(this.view.fov) * DEG2RAD;
    const hfov = this.hfovOf(vfov);
    this.target.yaw -= dx * anglePerPixel(hfov, this.cssW);
    this.target.pitch = this.clampPitch(this.target.pitch + dy * anglePerPixel(vfov, this.cssH));
    this.boundYaw();
  }

  /** A drag starts at time `t` (ms, the pointer events' clock). */
  dragStart(t: number): void {
    this.pauseAutoRotate();
    this.dragging = true;
    this.dragCount = 0;
    this.dragHead = 0;
    this.dragPeriod = DRAG_PERIOD_MS;
    this.dragAppliedX = 0;
    this.dragAppliedY = 0;
    this.dragFrameT = undefined;
    this.dragClockShift = 0;
    this.dragLeft.yaw = 0;
    this.dragLeft.pitch = 0;
    this.pushDrag(t, 0, 0);
  }

  /** The drag moved by (dx, dy) px at time `t`; step() moves the camera after it. */
  dragBy(dx: number, dy: number, t: number): void {
    if (!this.dragging) this.dragStart(t);
    this.pauseAutoRotate();
    const newest = (this.dragHead - 1 + DRAG_SAMPLES) % DRAG_SAMPLES;
    const x = this.dragX[newest]! + dx;
    const y = this.dragY[newest]! + dy;
    const gap = t - this.dragT[newest]!;
    if (gap > DRAG_REST_MS) {
      // After a rest: the pointer set off one frame ago, from where it rested.
      this.pushDrag(t - FRAME_MS, this.dragX[newest]!, this.dragY[newest]!);
    } else if (gap > 0) {
      this.dragPeriod += (gap - this.dragPeriod) * DRAG_PERIOD_GAIN;
    }
    // A move stamped before the one before it (a clock blip) is moved up to
    // it, so the samples stay in order.
    this.pushDrag(Math.max(t, this.dragT[newest]!), x, y);
    this.invalidate();
  }

  /**
   * The drag ended: the part of it not drawn yet goes to the target, for a
   * flick to take over or step()'s damping to ease in, so the camera ends
   * where the pointer did. With `now`, it moves the camera at once instead:
   * a pinch takes over from here, and a drag by the finger it leaves would
   * cut the easing short.
   */
  dragEnd(now = false): void {
    this.dragLeft.yaw = 0;
    this.dragLeft.pitch = 0;
    if (!this.dragging) return;
    this.dragging = false;
    const newest = (this.dragHead - 1 + DRAG_SAMPLES) % DRAG_SAMPLES;
    if (now) {
      // In one step: as a pinch arms on a fast touch drag, this can jump by
      // about one drag lag's worth of motion. A pinch snaps anyway, and by
      // the time a second finger has settled the first is usually slow.
      this.pan(this.dragX[newest]! - this.dragAppliedX, this.dragY[newest]! - this.dragAppliedY);
      this.invalidate();
      return;
    }
    // Measured against the view: panTarget() may shift view and target by a
    // whole turn together, which must not count as part of the drag.
    const yaw = this.target.yaw - this.view.yaw;
    const pitch = this.target.pitch - this.view.pitch;
    this.panTarget(
      this.dragX[newest]! - this.dragAppliedX,
      this.dragY[newest]! - this.dragAppliedY,
    );
    this.dragLeft.yaw = this.target.yaw - this.view.yaw - yaw;
    this.dragLeft.pitch = this.target.pitch - this.view.pitch - pitch;
    this.invalidate();
  }

  private pushDrag(t: number, x: number, y: number): void {
    this.dragT[this.dragHead] = t;
    this.dragX[this.dragHead] = x;
    this.dragY[this.dragHead] = y;
    this.dragHead = (this.dragHead + 1) % DRAG_SAMPLES;
    if (this.dragCount < DRAG_SAMPLES) this.dragCount++;
  }

  /**
   * Move the camera to the drag as of frame time `t`: the pointer
   * interpolated one input period back, through the one-euro filter. True
   * while the camera has yet to catch up with the newest move.
   */
  private followDrag(t: number): boolean {
    const newest = (this.dragHead - 1 + DRAG_SAMPLES) % DRAG_SAMPLES;
    const tNew = this.dragT[newest]!;
    // Only a clock running ahead gives itself away: a move can't come from
    // the future, but the newest one can be long past, when the pointer was
    // pressed and held. A frame drawn during a hold (a tile landing, a
    // timer) must not take the hold for a clock offset.
    if (tNew - t - this.dragClockShift > 1000) this.dragClockShift = tNew - t;
    const at =
      t + this.dragClockShift - Math.min(this.dragPeriod + DRAG_JITTER_MS, DRAG_LAG_MAX_MS);
    // The pointer at `at`: the newest move after it, the oldest kept before it.
    let i = newest;
    let rawX = this.dragX[newest]!;
    let rawY = this.dragY[newest]!;
    for (let n = 1; n < this.dragCount && this.dragT[i]! > at; n++) {
      const j = (i - 1 + DRAG_SAMPLES) % DRAG_SAMPLES;
      const tj = this.dragT[j]!;
      const ti = this.dragT[i]!;
      if (tj <= at) {
        const f = ti > tj ? (at - tj) / (ti - tj) : 1;
        rawX = this.dragX[j]! + (this.dragX[i]! - this.dragX[j]!) * f;
        rawY = this.dragY[j]! + (this.dragY[i]! - this.dragY[j]!) * f;
        break;
      }
      i = j;
      rawX = this.dragX[j]!;
      rawY = this.dragY[j]!;
    }

    let x = rawX;
    let y = rawY;
    if (this.dragFrameT === undefined) {
      this.dragSpeedX = 0;
      this.dragSpeedY = 0;
    } else {
      const dt = clamp(t - this.dragFrameT, 0, MAX_FRAME_DT_MS);
      x = this.dragAppliedX;
      y = this.dragAppliedY;
      if (dt > 0) {
        const s = smoothing(DRAG_SPEED_CUTOFF_HZ, dt);
        this.dragSpeedX += ((rawX - this.dragRawX) / dt - this.dragSpeedX) * s;
        this.dragSpeedY += ((rawY - this.dragRawY) / dt - this.dragSpeedY) * s;
        const hz = DRAG_MIN_CUTOFF_HZ + DRAG_BETA * Math.hypot(this.dragSpeedX, this.dragSpeedY);
        const a = smoothing(hz, dt);
        x += (rawX - x) * a;
        y += (rawY - y) * a;
      }
    }
    this.dragRawX = rawX;
    this.dragRawY = rawY;
    this.dragFrameT = t;
    // Not even a zero pan before the pointer moves: it would cut short an
    // ease still under way, as a drag does once it moves.
    if (x !== this.dragAppliedX || y !== this.dragAppliedY) {
      this.pan(x - this.dragAppliedX, y - this.dragAppliedY);
    }
    this.dragAppliedX = x;
    this.dragAppliedY = y;
    return (
      at < tNew || Math.hypot(this.dragX[newest]! - x, this.dragY[newest]! - y) > DRAG_SETTLE_PX
    );
  }

  // flick takes px per 60 Hz frame; momentum is kept in rad/ms.
  flick(vx: number, vy: number): void {
    this.pauseAutoRotate();
    const vfov = this.effectiveVFovDeg(this.view.fov) * DEG2RAD;
    const hfov = this.hfovOf(vfov);
    // 0 − vx, not −vx: no fling is +0, not −0.
    this.momentum.yaw = ((0 - vx) * anglePerPixel(hfov, this.cssW)) / FRAME_MS;
    this.momentum.pitch = (vy * anglePerPixel(vfov, this.cssH)) / FRAME_MS;
    const f = this.camera.momentumFriction;
    this.glideFriction = f;
    // A drag that just ended put what it had yet to draw on the target (see
    // dragEnd). The glide takes that over: a glide travels its momentum
    // times FRAME_MS / (1 − friction) in all, so it travels the fling's
    // distance and the leftover together if it sets off at the fling's
    // speed and decays a little slower. More momentum at the same friction
    // would start it faster than the drag went, and easing the leftover in
    // by damping would add its own burst of speed to the first frames.
    const left = this.dragLeft;
    if (f < 1 && (left.yaw !== 0 || left.pitch !== 0)) {
      const yaw = (this.momentum.yaw * FRAME_MS) / (1 - f) + left.yaw;
      const pitch = (this.momentum.pitch * FRAME_MS) / (1 - f) + left.pitch;
      const speed = Math.hypot(this.momentum.yaw, this.momentum.pitch) * FRAME_MS;
      // A leftover against the fling (or cancelling it) keeps the friction
      // and slows the start; with no fling at all, it glides at the most.
      const glide = clamp(1 - speed / Math.hypot(yaw, pitch), f, Math.max(f, GLIDE_FRICTION_MAX));
      const k = (1 - glide) / FRAME_MS;
      this.glideFriction = glide;
      this.momentum.yaw = yaw * k;
      this.momentum.pitch = pitch * k;
      this.target.yaw -= left.yaw;
      this.target.pitch -= left.pitch;
    }
    left.yaw = 0;
    left.pitch = 0;
    this.invalidate();
  }

  // Yaw stays unbounded (wrapping target across ±π makes damp() swing the long
  // way); shift view and target together by whole turns only, so the float
  // stays bounded and the rendered angle does not move.
  private boundYaw(): void {
    if (Math.abs(this.target.yaw) <= TAU) return;
    const shift = Math.trunc(this.target.yaw / TAU) * TAU;
    this.target.yaw -= shift;
    this.view.yaw -= shift;
  }

  /** Clear a glide, as an interaction: auto-rotate pauses. */
  stopMomentum(): void {
    this.pauseAutoRotate();
    this.stopMomentumOnly();
  }

  // stopMomentum without counting as an interaction: programmatic moves
  // clear a glide but leave auto-rotate alone.
  private stopMomentumOnly(): void {
    this.momentum.yaw = 0;
    this.momentum.pitch = 0;
    this.glideFriction = this.camera.momentumFriction;
    // The target has moved on from what the last drag left on it.
    this.dragLeft.yaw = 0;
    this.dragLeft.pitch = 0;
  }

  /** A zoom step by `scaleFactor` that keeps the scene under the pointer where it is. */
  zoomAt(scaleFactor: number, clientX: number, clientY: number): void {
    // A glide left running would carry the target, and the point under the
    // cursor with it, away from the anchor solved here.
    this.stopMomentum();
    const fov = this.zoomStep(this.target.fov, scaleFactor);
    const ndc = this.toNdc(clientX, clientY);
    const { yaw, pitch } = zoomAnchorView(
      this.zoomScratch,
      this.view,
      pointTangents(ndc, this.effectiveVFovDeg(this.view.fov), this.aspect, tanBefore),
      pointTangents(ndc, this.effectiveVFovDeg(fov), this.aspect, tanAfter),
      this.camera,
    );
    this.snapCamera(yaw, pitch, fov);
  }

  /** Move view and target to (yaw, pitch, fov) at once, with no easing: a zoom step. */
  private snapCamera(yaw: number, pitch: number, fov: number): void {
    this.view.yaw = unwound(yaw);
    this.target.yaw = this.view.yaw;
    this.view.pitch = pitch;
    this.target.pitch = pitch;
    this.view.fov = fov;
    this.target.fov = fov;
    this.invalidate();
  }

  // A pinch starts: remember the scene direction under its midpoint and the
  // fov on screen, which every later pinchTo() is solved from.
  pinchStart(clientX: number, clientY: number): void {
    this.stopMomentum();
    rayAt(this.pinchRay, this.view, this.pinchTangents(clientX, clientY, this.view.fov));
    this.pinchFov = this.view.fov;
  }

  /** The pinch midpoint as tangents, at the drawn fov for a requested `fovDeg`. */
  private pinchTangents(clientX: number, clientY: number, fovDeg: number): Tangents {
    return pointTangents(
      this.toNdc(clientX, clientY),
      this.effectiveVFovDeg(fovDeg),
      this.aspect,
      pinchPoint,
    );
  }

  // The pinch now: the fov is the start fov times `scale`, and the camera
  // puts the start direction under the midpoint, wherever it has moved. Each
  // step is solved from the start, so nothing builds up between events.
  pinchTo(scale: number, clientX: number, clientY: number): void {
    this.stopMomentum();
    const fov = this.zoomStep(this.pinchFov, scale);
    const { yaw, pitch } = aimRay(
      this.zoomScratch,
      this.pinchRay,
      this.pinchTangents(clientX, clientY, fov),
      this.view,
      this.camera,
    );
    this.snapCamera(yaw, pitch, fov);
  }

  /** Ease toward `view`'s axes; see `PanoViewerApi.setView`. */
  setView(view: Partial<View>): void {
    // The rendered yaw is unbounded (drags and auto-rotate wind it up), so
    // aim at the equivalent angle nearest to it rather than the literal one,
    // which could be several turns away.
    if (view.yaw !== undefined)
      this.target.yaw = this.view.yaw + normalizeAngle(view.yaw - this.view.yaw);
    if (view.pitch !== undefined) this.target.pitch = this.clampPitch(view.pitch);
    if (view.fov !== undefined) this.target.fov = this.clampFov(view.fov);
    this.stopMomentumOnly();
    this.invalidate();
  }

  /** Zoom by `factor` about the centre, easing; see `PanoViewerApi.zoomBy`. */
  zoomBy(factor: number): void {
    this.target.fov = this.zoomStep(this.target.fov, factor);
    this.stopMomentumOnly();
    this.invalidate();
  }

  /** The camera being moved to, with yaw in (−π, π]. */
  getView(): View {
    return { ...this.target, yaw: normalizeAngle(this.target.yaw) };
  }

  /**
   * Advance the camera to frame time `t` (ms), `dt` ms after the frame
   * before: a drag, then auto-rotate, then momentum, then damping toward the target.
   * True while the camera is still moving; false once it has settled, with
   * the view snapped exactly onto the target.
   */
  step(t: number, dt: number): boolean {
    const dragging = this.dragging && this.followDrag(t);
    if (this.autoRotating()) {
      // The first frame after (re)starting has no prior timestamp to diff
      // against, so it advances by zero rather than a stale or huge gap.
      const rotateMs =
        this.autoRotateLastFrame === undefined
          ? 0
          : clamp(t - this.autoRotateLastFrame, 0, MAX_FRAME_DT_MS);
      this.autoRotateLastFrame = t;
      this.target.yaw += this.autoRotate.speed * (rotateMs / 1000);
      this.boundYaw();
    } else {
      this.autoRotateLastFrame = undefined;
    }

    const steps = dt / FRAME_MS;

    if (this.momentum.yaw !== 0 || this.momentum.pitch !== 0) {
      // Momentum decays exponentially, so a step travels the integral of the
      // decay over dt. Scaled so a 60 Hz step travels exactly one frame's
      // worth, the total glide is the same at every frame rate.
      const f = this.glideFriction;
      const keep = f ** steps;
      const travel = f < 1 ? (FRAME_MS * (1 - keep)) / (1 - f) : dt;
      // The glide carries the view as well as the target, so a released
      // drag goes on at its own speed instead of easing in after the target.
      this.view.yaw += this.momentum.yaw * travel;
      this.view.pitch = this.clampPitch(this.view.pitch + this.momentum.pitch * travel);
      this.target.yaw += this.momentum.yaw * travel;
      this.target.pitch = this.clampPitch(this.target.pitch + this.momentum.pitch * travel);
      this.momentum.yaw *= keep;
      this.momentum.pitch *= keep;
      // A glide decaying slower than the camera's friction stops as little
      // short of where it was going: at the same distance left, not speed.
      const fc = this.camera.momentumFriction;
      const eps = f === fc ? MOMENTUM_EPS : (MOMENTUM_EPS * (1 - f)) / (1 - fc);
      if (Math.hypot(this.momentum.yaw, this.momentum.pitch) < eps) {
        this.momentum.yaw = 0;
        this.momentum.pitch = 0;
      }
    }

    const k = 1 - (1 - this.camera.damping) ** steps;
    const view = this.view;
    const target = this.target;
    view.yaw = damp(view.yaw, target.yaw, k);
    view.pitch = damp(view.pitch, target.pitch, k);
    view.fov = damp(view.fov, target.fov, k);

    // Still moving unless no drag is catching up, no momentum is left and
    // the camera has eased all the way to its target.
    const settled =
      !dragging &&
      this.momentum.yaw === 0 &&
      this.momentum.pitch === 0 &&
      Math.abs(target.yaw - view.yaw) < 1e-4 &&
      Math.abs(target.pitch - view.pitch) < 1e-4 &&
      Math.abs(target.fov - view.fov) < 1e-3;
    if (!settled) return true;
    view.yaw = target.yaw;
    view.pitch = target.pitch;
    view.fov = target.fov;
    return false;
  }

  /** Stop the auto-rotate resume timer. */
  dispose(): void {
    clearTimeout(this.autoRotateResumeTimer);
  }
}
