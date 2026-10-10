import { pinchFactor } from './camera-math.js';

export interface ControlHost {
  panByPixels(dx: number, dy: number): void;
  zoomAt(scaleFactor: number, clientX: number, clientY: number): void;
  flick(vx: number, vy: number): void;
  stopMomentum(): void;
}

/** Pointer state for one of the (at most two) tracked pointers. */
interface PointerSlot {
  id: number;
  x: number;
  y: number;
}

// A release more than this long after the last move is a rest, not a fling.
const FLING_STALE_MS = 60;
// Release velocity is measured over the moves in this trailing window.
const FLING_WINDOW_MS = 100;
// The host's flick() takes px per 60 Hz frame.
const FRAME_MS = 1000 / 60;
// Ring buffer size for drag samples. 100 ms of 240 Hz input fits in 24.
const SAMPLES = 32;

export class Controls {
  // Two slots instead of a Map: a pinch needs only two fingers, and fixed
  // slots avoid allocating on every pointermove. Extra fingers are ignored.
  private p0: PointerSlot | null = null;
  private p1: PointerSlot | null = null;
  private last = { x: 0, y: 0 };
  private prevDist = 0;
  // Recent drag positions and timestamps (ring buffer) for release velocity.
  private sampleT = new Float64Array(SAMPLES);
  private sampleX = new Float64Array(SAMPLES);
  private sampleY = new Float64Array(SAMPLES);
  private sampleCount = 0;
  private sampleHead = 0;
  // Set once a gesture goes multi-touch (pinch). Blocks single-finger panning
  // until ALL fingers lift, so a finger lingering after a pinch can't pan.
  private gestureConsumed = false;

  constructor(
    private el: HTMLElement,
    private host: ControlHost,
  ) {
    el.style.touchAction = 'none';
    el.tabIndex = 0;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onCancel);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', this.onContextMenu);
    el.addEventListener('dblclick', this.onDblClick);
    el.addEventListener('keydown', this.onKeyDown);
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
   * Release velocity in px per 60 Hz frame, from the samples in the last
   * FLING_WINDOW_MS. Zero if the pointer has rested for FLING_STALE_MS:
   * no pointermove fires while a finger holds still, so without this check
   * a pause before release would still fling with the old velocity.
   */
  private releaseVelocity(now: number): [number, number] {
    if (this.sampleCount < 2) return [0, 0];
    const newest = (this.sampleHead - 1 + SAMPLES) % SAMPLES;
    const tNew = this.sampleT[newest]!;
    if (now - tNew > FLING_STALE_MS) return [0, 0];
    let oldest = newest;
    for (let i = 1; i < this.sampleCount; i++) {
      const j = (newest - i + SAMPLES) % SAMPLES;
      if (tNew - this.sampleT[j]! > FLING_WINDOW_MS) break;
      oldest = j;
    }
    const dt = tNew - this.sampleT[oldest]!;
    if (dt <= 0) return [0, 0];
    const k = FRAME_MS / dt;
    return [
      (this.sampleX[newest]! - this.sampleX[oldest]!) * k,
      (this.sampleY[newest]! - this.sampleY[oldest]!) * k,
    ];
  }

  private onDown = (e: PointerEvent) => {
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
    this.last = { x: e.clientX, y: e.clientY };
    if (this.p0 && this.p1) {
      // A second finger makes this a multi-touch (pinch) gesture.
      this.gestureConsumed = true;
      this.prevDist = Math.hypot(this.p0.x - this.p1.x, this.p0.y - this.p1.y);
    }
    // Grabbing halts any ongoing inertial glide and resets velocity tracking.
    this.host.stopMomentum();
    this.sampleCount = 0;
    this.pushSample(e.timeStamp, e.clientX, e.clientY);
    this.el.style.cursor = 'grabbing';
  };

  private onMove = (e: PointerEvent) => {
    const slot = this.slotFor(e.pointerId);
    if (!slot) return;
    slot.x = e.clientX;
    slot.y = e.clientY;

    const { p0, p1 } = this;
    if (p0 && p1) {
      const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
      if (this.prevDist && dist) {
        const scale = pinchFactor(this.prevDist, dist);
        this.host.zoomAt(scale, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
      }
      this.prevDist = dist;
      return;
    }

    // A finger left over from a pinch must not pan; wait for a fresh gesture.
    if (this.gestureConsumed) {
      this.last = { x: e.clientX, y: e.clientY };
      return;
    }

    // Single pointer drag
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.last = { x: e.clientX, y: e.clientY };
    this.host.panByPixels(dx, dy);
    this.pushSample(e.timeStamp, e.clientX, e.clientY);
  };

  private onUp = (e: PointerEvent) => this.release(e, true);

  // A cancelled pointer (system gesture, browser takeover) never flings.
  private onCancel = (e: PointerEvent) => this.release(e, false);

  private release(e: PointerEvent, fling: boolean) {
    if (!this.slotFor(e.pointerId)) return;
    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch {
      // ignore — pointer may not be captured
    }
    if (this.p0?.id === e.pointerId) this.p0 = null;
    else this.p1 = null;
    this.prevDist = 0;
    if (this.p0 || this.p1) return;
    // Only fling from a real drag — not from the tail of a pinch.
    if (fling && !this.gestureConsumed) {
      const [vx, vy] = this.releaseVelocity(e.timeStamp);
      this.host.flick(vx, vy);
    }
    this.gestureConsumed = false;
    this.sampleCount = 0;
    this.last = { x: 0, y: 0 };
    this.el.style.cursor = 'grab';
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const scale = Math.exp(e.deltaY * 0.001);
    this.host.zoomAt(scale, e.clientX, e.clientY);
  };

  private onContextMenu = (e: Event) => e.preventDefault();

  private onDblClick = (e: MouseEvent) => {
    e.preventDefault();
    this.host.zoomAt(0.6, e.clientX, e.clientY); // step in toward the point
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const panStep = 40; // px-equivalent
    switch (e.key) {
      case 'ArrowLeft':
        this.host.panByPixels(panStep, 0);
        break;
      case 'ArrowRight':
        this.host.panByPixels(-panStep, 0);
        break;
      case 'ArrowUp':
        this.host.panByPixels(0, panStep);
        break;
      case 'ArrowDown':
        this.host.panByPixels(0, -panStep);
        break;
      case '+':
      case '=':
        this.zoomCenter(0.8);
        break;
      case '-':
      case '_':
        this.zoomCenter(1.25);
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
    this.el.removeEventListener('wheel', this.onWheel);
    this.el.removeEventListener('contextmenu', this.onContextMenu);
    this.el.removeEventListener('dblclick', this.onDblClick);
    this.el.removeEventListener('keydown', this.onKeyDown);
  }
}
