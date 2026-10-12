/**
 * The few browser pieces a PanoViewer touches beyond its renderer: the
 * animation frame clock and the two observers. Stub them in with
 * vi.stubGlobal; each records what it was given and lets the test fire it.
 */
import { vi } from 'vitest';

/** One 60 Hz frame, ms. */
export const FRAME_MS = 1000 / 60;

/** Let every pending task and the microtasks behind it run. */
export const flushTasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * requestAnimationFrame stand-in: callbacks queue up and run when the test
 * calls step(), at a clock that advances one 60 Hz frame per step unless the
 * test names the time.
 */
export class FakeRaf {
  private queue = new Map<number, FrameRequestCallback>();
  private nextId = 1;
  now = 0;
  request = vi.fn((cb: FrameRequestCallback) => {
    const id = this.nextId++;
    this.queue.set(id, cb);
    return id;
  });
  cancel = vi.fn((id: number) => {
    this.queue.delete(id);
  });
  get pending(): number {
    return this.queue.size;
  }
  step(t = this.now + FRAME_MS): void {
    this.now = t;
    const due = [...this.queue.values()];
    this.queue.clear();
    for (const cb of due) cb(t);
  }
}

export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: unknown[] = [];
  disconnect = vi.fn();
  constructor(private cb: (entries: unknown[]) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: unknown): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  trigger(width: number, height: number): void {
    this.cb([{ contentRect: { width, height } }]);
  }
}

export class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed: unknown[] = [];
  disconnect = vi.fn();
  constructor(private cb: (entries: unknown[]) => void) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: unknown): void {
    this.observed.push(el);
  }
  trigger(isIntersecting: boolean): void {
    this.cb([{ isIntersecting }]);
  }
}
