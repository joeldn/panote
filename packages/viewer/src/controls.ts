import { pinchFactor } from './camera-math.js';
import type { ResolvedViewerOptions, WheelMode } from './types.js';

export interface ControlHost {
  /** Move the camera now, with no easing (a wheel swipe). */
  panByPixels(dx: number, dy: number): void;
  /** A drag starts at time `t` (the pointer events' timeStamp clock, ms). */
  dragStart(t: number): void;
  /** The drag moved by (dx, dy) px at time `t`; the camera follows it frame by frame. */
  dragBy(dx: number, dy: number, t: number): void;
  /**
   * The drag ended: the camera catches up with where the pointer let go,
   * easing, or at once with `now`.
   */
  dragEnd(now?: boolean): void;
  /** Move where the camera is heading, and let damping ease it there (keys). */
  panTargetByPixels(dx: number, dy: number): void;
  zoomAt(scaleFactor: number, clientX: number, clientY: number): void;
  /** A pinch starts with its midpoint here. */
  pinchStart(clientX: number, clientY: number): void;
  /**
   * The pinch now: fov at `scaleFactor` times the fov it started at, and the
   * scene point that was under the start midpoint now under this one.
   */
  pinchTo(scaleFactor: number, clientX: number, clientY: number): void;
  flick(vx: number, vy: number): void;
  stopMomentum(): void;
}

/** The input half of the resolved interaction options. */
export type ControlsOptions = Pick<
  ResolvedViewerOptions['interaction'],
  'cursor' | 'wheel' | 'wheelGain' | 'pinchGain' | 'keyboard' | 'doubleClickZoom' | 'inertia'
>;

/** Pointer state for one of the (at most two) tracked pointers. */
interface PointerSlot {
  id: number;
  x: number;
  y: number;
}

// A pointer lets go a moment after it stops: a mouse button or a trackpad
// click takes time to lift. A release up to FLING_HOLD_MS after the last move
// flings at full speed, a later one more and more gently, and one
// FLING_STALE_MS or more after it was a deliberate hold and does not fling.
const FLING_HOLD_MS = 40;
const FLING_STALE_MS = 100;
// Release velocity is measured over the moves in this trailing window.
const FLING_WINDOW_MS = 100;
// The host's flick() takes px per 60 Hz frame.
const FRAME_MS = 1000 / 60;
// A ctrl-wheel with a pixel delta under this is a trackpad pinch and gets the
// pinch gain. Ctrl plus a mouse notch (deltaY about 100, or line mode) keeps
// the plain wheel gain.
const PINCH_MAX_DELTA = 50;
// Cap on |ln(scale)| from one wheel event, so a page-mode delta or a
// high-resolution wheel burst can't jump the fov.
const MAX_WHEEL_LOG_SCALE = 0.3;
// deltaMode 1 (lines) is converted at a 16 px line height.
const LINE_PX = 16;
// Wheel events closer together than this are one gesture (a scroll and its
// momentum tail), which keeps the axis its first event picked.
export const WHEEL_GESTURE_GAP_MS = 120;

/** Safari's non-standard GestureEvent, fired for trackpad pinch on macOS. */
interface SafariGestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

// Ring buffer size for drag samples: 100 ms of 240 Hz input is 24, with headroom.
const SAMPLES = 32;

export class Controls {
  // Two slots instead of a Map: a pinch needs only two fingers, and fixed
  // slots avoid allocating on every pointermove. Extra fingers are ignored.
  private p0: PointerSlot | null = null;
  private p1: PointerSlot | null = null;
  private last = { x: 0, y: 0 };
  // Finger distance when the pinch started; the zoom is relative to it.
  private pinchDist0 = 0;
  // Recent drag positions and timestamps (ring buffer) for release velocity.
  private sampleT = new Float64Array(SAMPLES);
  private sampleX = new Float64Array(SAMPLES);
  private sampleY = new Float64Array(SAMPLES);
  private sampleCount = 0;
  private sampleHead = 0;
  // Set once a gesture goes multi-touch (pinch), until ALL fingers lift: a
  // finger left after a pinch drags on, but its release never flings.
  private gestureConsumed = false;
  // Starting scale and client point of an in-progress Safari pinch, or null.
  private gestureScale: number | null = null;
  private gestureX = 0;
  private gestureY = 0;
  // The current wheel gesture: the axis it drives (null until an event with
  // a delta picks it), when its last event came, and whether ctrl was held.
  private wheelAxis: 'zoom' | 'pan' | null = null;
  private wheelT = -Infinity;
  private wheelCtrl = false;
  private readonly opts: ControlsOptions;
  private readonly wheelMode: WheelMode;
  // Whether the user has engaged the viewer (see WheelMode 'engaged').
  private engaged = false;

  constructor(
    private el: HTMLElement,
    private host: ControlHost,
    opts: ControlsOptions,
  ) {
    this.opts = opts;
    el.style.touchAction = 'none';
    this.setCursor('grab');
    // Focusable for its keys; without them it stays out of the tab order.
    if (this.opts.keyboard) el.tabIndex = 0;
    this.wheelMode = this.opts.wheel;
    // The element may already have focus when Controls is built.
    this.engaged = el.ownerDocument?.activeElement === el;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onCancel);
    // Capture lost without a pointerup (the canvas re-parented, a browser or
    // OS takeover that sends a mouse no pointercancel) ends the drag too.
    el.addEventListener('lostpointercapture', this.onUp);
    if (this.wheelMode !== 'off') el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', this.onContextMenu);
    if (this.opts.doubleClickZoom !== false) el.addEventListener('dblclick', this.onDblClick);
    if (this.opts.keyboard) el.addEventListener('keydown', this.onKeyDown);
    el.addEventListener('gesturestart', this.onGestureStart);
    el.addEventListener('gesturechange', this.onGestureChange);
    el.addEventListener('gestureend', this.onGestureEnd);
    el.addEventListener('focus', this.onEngage);
    el.addEventListener('blur', this.onDisengage);
    el.addEventListener('pointerleave', this.onPointerLeave);
  }

  private setCursor(cursor: 'grab' | 'grabbing'): void {
    if (this.opts.cursor) this.el.style.cursor = cursor;
  }

  private onEngage = () => {
    this.engaged = true;
  };

  private onDisengage = () => {
    this.engaged = false;
  };

  // Touch and pen pointers "leave" on every lift, which says nothing about
  // whether the user is done with the viewer; only a mouse leaving does.
  private onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') this.engaged = false;
  };

  // Written in place: a pointermove allocates nothing.
  private moveLast(x: number, y: number): void {
    this.last.x = x;
    this.last.y = y;
  }

  private slotFor(id: number): PointerSlot | null {
    if (this.p0?.id === id) return this.p0;
    if (this.p1?.id === id) return this.p1;
    return null;
  }

  private pushSample(t: number, x: number, y: number) {
    this.sampleT[this.sampleHead] = t;
    this.sampleX[this.sampleHead] = x;
    this.sampleY[this.sampleHead] = y;
    this.sampleHead = (this.sampleHead + 1) % SAMPLES;
    if (this.sampleCount < SAMPLES) this.sampleCount++;
  }

  /**
   * Release velocity in px per 60 Hz frame: the time-weighted mean over the
   * samples in the last FLING_WINDOW_MS, faded by how long the pointer rested
   * before `now`. No pointermove fires while a pointer holds still, so
   * without the fade a pause before release would fling with the old speed.
   */
  private releaseVelocity(now: number): [number, number] {
    if (this.sampleCount < 2) return [0, 0];
    const newest = (this.sampleHead - 1 + SAMPLES) % SAMPLES;
    const tNew = this.sampleT[newest]!;
    const rest = now - tNew;
    if (rest >= FLING_STALE_MS) return [0, 0];
    const fade =
      rest <= FLING_HOLD_MS ? 1 : (FLING_STALE_MS - rest) / (FLING_STALE_MS - FLING_HOLD_MS);
    let oldest = newest;
    for (let i = 1; i < this.sampleCount; i++) {
      const j = (newest - i + SAMPLES) % SAMPLES;
      if (tNew - this.sampleT[j]! > FLING_WINDOW_MS) break;
      oldest = j;
    }
    const dt = tNew - this.sampleT[oldest]!;
    if (dt <= 0) return [0, 0];
    const k = (FRAME_MS / dt) * fade;
    return [
      (this.sampleX[newest]! - this.sampleX[oldest]!) * k,
      (this.sampleY[newest]! - this.sampleY[oldest]!) * k,
    ];
  }

  private onDown = (e: PointerEvent) => {
    this.engaged = true;
    // Only the primary mouse button drags; right-click and middle-click don't.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.slotFor(e.pointerId)) return;
    const slot = { id: e.pointerId, x: e.clientX, y: e.clientY };
    if (!this.p0) this.p0 = slot;
    else if (!this.p1) this.p1 = slot;
    else return; // a third finger plays no part in the gesture
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // ignore — capture is best-effort and must not break gesture handling
    }
    this.moveLast(e.clientX, e.clientY);
    if (this.p0 && this.p1) {
      // A second finger makes this a multi-touch (pinch) gesture, a new one
      // each time a finger lands; the pinch takes over from the drag.
      this.host.dragEnd(true);
      this.gestureConsumed = true;
      this.pinchDist0 = Math.hypot(this.p0.x - this.p1.x, this.p0.y - this.p1.y);
      this.host.pinchStart((this.p0.x + this.p1.x) / 2, (this.p0.y + this.p1.y) / 2);
    }
    // Grabbing halts any ongoing inertial glide and resets velocity tracking.
    this.host.stopMomentum();
    if (!this.p1) this.host.dragStart(e.timeStamp);
    this.sampleCount = 0;
    this.pushSample(e.timeStamp, e.clientX, e.clientY);
    this.setCursor('grabbing');
  };

  private onMove = (e: PointerEvent) => {
    const slot = this.slotFor(e.pointerId);
    if (!slot) return;
    // A mouse moving with no button held has been released: a hover must not
    // pan, and the slot must be free for the next press. macOS browsers read
    // `buttons` from the live button state, so this can be the last move of
    // a flick, handled just after the click lifted: it releases like the
    // pointerup, which then finds no slot. A pointerup missed for good shows
    // up long after the last move, and the rest fades its fling to nothing.
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      this.release(e, true);
      return;
    }
    slot.x = e.clientX;
    slot.y = e.clientY;

    const { p0, p1 } = this;
    if (p0 && p1) {
      // Both fingers' latest positions, against the pinch's start: a zoom
      // and a pan together, the scene between the fingers following them.
      const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
      if (this.pinchDist0 && dist) {
        const scale = pinchFactor(this.pinchDist0, dist);
        this.host.pinchTo(scale, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
      }
      return;
    }

    // Single pointer drag
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.moveLast(e.clientX, e.clientY);
    this.host.dragBy(dx, dy, e.timeStamp);
    this.pushSample(e.timeStamp, e.clientX, e.clientY);
  };

  // A pointerup, or the capture lost with the pointer still held: a
  // pointercancel comes first when the browser takes the pointer over, so
  // capture lost on a held pointer is a release.
  private onUp = (e: PointerEvent) => this.release(e, true);

  // A cancelled pointer (system gesture, browser takeover) never flings.
  private onCancel = (e: PointerEvent) => this.release(e, false);

  private release(e: PointerEvent, fling: boolean) {
    if (!this.slotFor(e.pointerId)) return;
    // Free the slot first: a lostpointercapture fired from inside
    // releasePointerCapture then finds no slot, and cannot end the drag
    // again without its fling.
    if (this.p0?.id === e.pointerId) this.p0 = null;
    else this.p1 = null;
    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch {
      // ignore — pointer may not be captured
    }
    this.pinchDist0 = 0;
    const left = this.p0 ?? this.p1;
    if (left) {
      // The finger left drags on from where it is, with no jump.
      this.moveLast(left.x, left.y);
      this.host.dragStart(e.timeStamp);
      return;
    }
    this.host.dragEnd();
    // Only fling from a real drag — not from the tail of a pinch.
    if (fling && this.opts.inertia && !this.gestureConsumed) {
      const [vx, vy] = this.releaseVelocity(e.timeStamp);
      this.host.flick(vx, vy);
    }
    this.gestureConsumed = false;
    this.sampleCount = 0;
    this.moveLast(0, 0);
    this.setCursor('grab');
  }

  private onWheel = (e: WheelEvent) => {
    // An unengaged embed leaves a plain wheel to the page, so it scrolls.
    if (this.wheelMode === 'engaged' && !this.engaged && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    // Safari may send ctrl-wheel alongside its pinch gesture; zoom once.
    if (e.ctrlKey && this.gestureScale !== null) return;
    const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? this.el.clientHeight || 800 : 1;
    const dy = e.deltaY * unit;
    const dx = e.deltaX * unit;
    // One axis per gesture: a scroll-zoom is never exactly vertical, and its
    // momentum tail decays until the sideways jitter outweighs it, so a
    // deltaX riding along a zoom must not pan (it would slide the point
    // under the cursor), and a sideways swipe must not zoom. The first event
    // with a delta picks the larger axis; a pinch (ctrl-wheel) always zooms,
    // and pressing or releasing ctrl starts a new gesture.
    const t = e.timeStamp;
    if (!(t - this.wheelT <= WHEEL_GESTURE_GAP_MS) || e.ctrlKey !== this.wheelCtrl) {
      this.wheelAxis = null;
    }
    this.wheelT = t;
    this.wheelCtrl = e.ctrlKey;
    if (this.wheelAxis === null && (dx || dy)) {
      this.wheelAxis = e.ctrlKey || Math.abs(dy) >= Math.abs(dx) ? 'zoom' : 'pan';
    }
    if (this.wheelAxis === 'zoom' && dy) {
      const pinch = e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaY) < PINCH_MAX_DELTA;
      const gain = pinch ? this.opts.pinchGain : this.opts.wheelGain;
      const logScale = Math.max(-MAX_WHEEL_LOG_SCALE, Math.min(MAX_WHEEL_LOG_SCALE, dy * gain));
      this.host.zoomAt(Math.exp(logScale), e.clientX, e.clientY);
    } else if (this.wheelAxis === 'pan' && dx) {
      // A horizontal two-finger swipe pans like a drag in the same direction.
      this.host.panByPixels(-dx, 0);
    }
  };

  // Best effort: these events exist only in Safari. macOS reports a trackpad
  // pinch as a gesture with a cumulative scale instead of a ctrl-wheel. iOS
  // and iPadOS also fire them for a two-finger touch pinch, alongside the
  // pointer events, so while a pointer is tracked the pointer pinch is the
  // source of truth and the gesture is only claimed (no page zoom).
  private onGestureStart = (e: Event) => {
    e.preventDefault();
    if (this.p0 || this.p1) return;
    const g = e as SafariGestureEvent;
    this.gestureScale = g.scale || 1;
    // GestureEvent may come without coordinates; zoom about the centre then.
    if (Number.isFinite(g.clientX) && Number.isFinite(g.clientY)) {
      this.gestureX = g.clientX;
      this.gestureY = g.clientY;
    } else {
      const r = this.el.getBoundingClientRect();
      this.gestureX = r.left + r.width / 2;
      this.gestureY = r.top + r.height / 2;
    }
    this.host.pinchStart(this.gestureX, this.gestureY);
  };

  private onGestureChange = (e: Event) => {
    e.preventDefault();
    if (this.p0 || this.p1) return;
    const g = e as SafariGestureEvent;
    if (this.gestureScale === null || !g.scale) return;
    // The scale is cumulative, so each change is solved from the start,
    // about the point where the pinch began.
    this.host.pinchTo(pinchFactor(this.gestureScale, g.scale), this.gestureX, this.gestureY);
  };

  private onGestureEnd = (e: Event) => {
    e.preventDefault();
    this.gestureScale = null;
  };

  private onContextMenu = (e: Event) => e.preventDefault();

  private onDblClick = (e: MouseEvent) => {
    const factor = this.opts.doubleClickZoom;
    if (factor === false) return;
    e.preventDefault();
    this.host.zoomAt(factor, e.clientX, e.clientY); // step in toward the point
  };

  private onKeyDown = (e: KeyboardEvent) => {
    // Modified keys belong to the browser and OS: Ctrl/Cmd +/- is page zoom,
    // which low-vision users rely on, and Alt/Cmd+arrow is history navigation.
    // AltGr arrives as Ctrl+Alt on Windows and types characters, so it
    // excuses Ctrl and Alt, but never Cmd.
    if (e.metaKey) return;
    const altGraph = e.getModifierState?.('AltGraph') ?? false;
    if (!altGraph && (e.ctrlKey || e.altKey)) return;
    const keys = this.opts.keyboard;
    if (!keys) return;
    // Keys move the target, not the camera, so damping smooths key repeat
    // into a glide instead of 40 px jumps.
    const panStep = keys.panStepPx;
    switch (e.key) {
      case 'ArrowLeft':
        this.host.panTargetByPixels(panStep, 0);
        break;
      case 'ArrowRight':
        this.host.panTargetByPixels(-panStep, 0);
        break;
      case 'ArrowUp':
        this.host.panTargetByPixels(0, panStep);
        break;
      case 'ArrowDown':
        this.host.panTargetByPixels(0, -panStep);
        break;
      case '+':
      case '=':
        this.zoomCenter(keys.zoomStep);
        break;
      case '-':
      case '_':
        this.zoomCenter(1 / keys.zoomStep);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  private zoomCenter(scale: number) {
    const r = this.el.getBoundingClientRect();
    this.host.zoomAt(scale, r.left + r.width / 2, r.top + r.height / 2);
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointercancel', this.onCancel);
    this.el.removeEventListener('lostpointercapture', this.onUp);
    this.el.removeEventListener('wheel', this.onWheel);
    this.el.removeEventListener('contextmenu', this.onContextMenu);
    this.el.removeEventListener('dblclick', this.onDblClick);
    this.el.removeEventListener('keydown', this.onKeyDown);
    this.el.removeEventListener('gesturestart', this.onGestureStart);
    this.el.removeEventListener('gesturechange', this.onGestureChange);
    this.el.removeEventListener('gestureend', this.onGestureEnd);
    this.el.removeEventListener('focus', this.onEngage);
    this.el.removeEventListener('blur', this.onDisengage);
    this.el.removeEventListener('pointerleave', this.onPointerLeave);
  }
}
