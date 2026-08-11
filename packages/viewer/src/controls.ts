import { pinchFactor } from './camera-math.js';

export interface ControlHost {
  panByPixels(dx: number, dy: number): void;
  zoomAt(scaleFactor: number, clientX: number, clientY: number): void;
  flick(vx: number, vy: number): void;
  stopMomentum(): void;
}

export class Controls {
  private pointers = new Map<number, { x: number; y: number }>();
  private last = { x: 0, y: 0 };
  private prevDist = 0;
  // Smoothed drag velocity (px per move event) used to seed release inertia.
  private vx = 0;
  private vy = 0;
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
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', this.onContextMenu);
    el.addEventListener('dblclick', this.onDblClick);
    el.addEventListener('keydown', this.onKeyDown);
  }

  private onDown = (e: PointerEvent) => {
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // ignore — capture is best-effort and must not break gesture handling
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.last = { x: e.clientX, y: e.clientY };
    // A second finger makes this a multi-touch (pinch) gesture.
    if (this.pointers.size >= 2) this.gestureConsumed = true;
    // Grabbing halts any ongoing inertial glide and resets velocity tracking.
    this.host.stopMomentum();
    this.vx = 0;
    this.vy = 0;
    this.el.style.cursor = 'grabbing';
  };

  private onMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size >= 2) {
      const [p0, p1] = [...this.pointers.values()];
      if (p0 && p1) {
        const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
        if (this.prevDist) {
          const scale = pinchFactor(this.prevDist, dist);
          const midX = (p0.x + p1.x) / 2;
          const midY = (p0.y + p1.y) / 2;
          this.host.zoomAt(scale, midX, midY);
        }
        this.prevDist = dist;
      }
      // Pinching is not a drag — don't let it seed release inertia.
      this.gestureConsumed = true;
      this.vx = 0;
      this.vy = 0;
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
    // Track a smoothed velocity so a release can fling with inertia.
    this.vx = this.vx * 0.6 + dx * 0.4;
    this.vy = this.vy * 0.6 + dy * 0.4;
  };

  private onUp = (e: PointerEvent) => {
    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch {
      // ignore — pointer may not be captured
    }
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.prevDist = 0;
    if (this.pointers.size === 0) {
      // Only fling from a real drag — not from the tail of a pinch.
      if (!this.gestureConsumed) this.host.flick(this.vx, this.vy);
      this.gestureConsumed = false;
      this.vx = 0;
      this.vy = 0;
      this.last = { x: 0, y: 0 };
      this.el.style.cursor = 'grab';
    }
  };

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
    this.el.removeEventListener('pointercancel', this.onUp);
    this.el.removeEventListener('wheel', this.onWheel);
    this.el.removeEventListener('contextmenu', this.onContextMenu);
    this.el.removeEventListener('dblclick', this.onDblClick);
    this.el.removeEventListener('keydown', this.onKeyDown);
  }
}
