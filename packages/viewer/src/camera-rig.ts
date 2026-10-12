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
  // Release inertia, in rad/ms.
  private momentum = { yaw: 0, pitch: 0 };
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

  /** Move the camera now: a drag follows the pointer exactly. */
  panByPixels(dx: number, dy: number): void {
    this.pauseAutoRotate();
    const vfov = this.effectiveVFovDeg(this.view.fov) * DEG2RAD;
    const hfov = this.hfovOf(vfov);
    // drag right → look left
    const yaw = unwound(this.view.yaw - dx * anglePerPixel(hfov, this.cssW));
    const pitch = this.clampPitch(this.view.pitch + dy * anglePerPixel(vfov, this.cssH));
    this.view.yaw = yaw;
    this.target.yaw = yaw;
    this.view.pitch = pitch;
    this.target.pitch = pitch;
    this.invalidate();
  }

  // panByPixels for the keyboard: moves only the target, so step()'s
  // damping eases the camera after it and key repeat glides.
  panTargetByPixels(dx: number, dy: number): void {
    this.pauseAutoRotate();
    const vfov = this.effectiveVFovDeg(this.view.fov) * DEG2RAD;
    const hfov = this.hfovOf(vfov);
    this.target.yaw -= dx * anglePerPixel(hfov, this.cssW);
    this.target.pitch = this.clampPitch(this.target.pitch + dy * anglePerPixel(vfov, this.cssH));
    this.boundYaw();
    this.invalidate();
  }

  // flick takes px per 60 Hz frame; momentum is kept in rad/ms.
  flick(vx: number, vy: number): void {
    this.pauseAutoRotate();
    const vfov = this.effectiveVFovDeg(this.view.fov) * DEG2RAD;
    const hfov = this.hfovOf(vfov);
    this.momentum.yaw = (-vx * anglePerPixel(hfov, this.cssW)) / FRAME_MS;
    this.momentum.pitch = (vy * anglePerPixel(vfov, this.cssH)) / FRAME_MS;
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
   * before: auto-rotate, then momentum, then damping toward the target.
   * True while the camera is still moving; false once it has settled, with
   * the view snapped exactly onto the target.
   */
  step(t: number, dt: number): boolean {
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
      const f = this.camera.momentumFriction;
      const keep = f ** steps;
      const travel = f < 1 ? (FRAME_MS * (1 - keep)) / (1 - f) : dt;
      this.target.yaw += this.momentum.yaw * travel;
      this.target.pitch = this.clampPitch(this.target.pitch + this.momentum.pitch * travel);
      this.momentum.yaw *= keep;
      this.momentum.pitch *= keep;
      if (Math.hypot(this.momentum.yaw, this.momentum.pitch) < MOMENTUM_EPS) {
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

    // Still moving unless no momentum is left and the camera has eased all
    // the way to its target.
    const settled =
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
