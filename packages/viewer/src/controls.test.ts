import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Controls, type ControlHost, type ControlsOptions } from './controls.js';

/**
 * Controls only needs a small slice of HTMLElement, so these tests run in Node
 * against a fake element and plain event objects instead of a DOM.
 */
type Listener = (e: unknown) => void;

class FakeElement {
  style: Record<string, string> = {};
  tabIndex = -1;
  role: string | null = null;
  ariaLabel: string | null = null;
  listeners = new Map<string, Set<Listener>>();
  rect = { left: 0, top: 0, width: 800, height: 600 };

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
    return this.rect;
  }
  get clientHeight() {
    return this.rect.height;
  }
  dispatch<T extends object>(type: string, init: T) {
    const ev = {
      type,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...init,
    };
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    return ev;
  }
}

function makeHost() {
  return {
    panByPixels: vi.fn<ControlHost['panByPixels']>(),
    zoomAt: vi.fn<ControlHost['zoomAt']>(),
    flick: vi.fn<ControlHost['flick']>(),
    stopMomentum: vi.fn<ControlHost['stopMomentum']>(),
  };
}

let el: FakeElement;
let host: ReturnType<typeof makeHost>;

function setup(opts?: ControlsOptions) {
  el = new FakeElement();
  host = makeHost();
  return new Controls(el as unknown as HTMLElement, host, opts);
}

function pointer(
  type: string,
  init: { x: number; y: number; t: number; id?: number; button?: number; pointerType?: string },
) {
  return el.dispatch(type, {
    pointerId: init.id ?? 1,
    pointerType: init.pointerType ?? 'mouse',
    button: init.button ?? 0,
    clientX: init.x,
    clientY: init.y,
    timeStamp: init.t,
  });
}

/** Drag from x=0 to the right in 10 px steps, one every 16 ms. */
function drag(steps: number, start = 0) {
  pointer('pointerdown', { x: 0, y: 0, t: start });
  for (let i = 1; i <= steps; i++) pointer('pointermove', { x: i * 10, y: 0, t: start + i * 16 });
  return start + steps * 16;
}

describe('Controls: pointer drag and release', () => {
  beforeEach(() => {
    setup();
  });

  it('flings after a quick release, in px per 16.67 ms frame', () => {
    const t = drag(5);
    pointer('pointerup', { x: 50, y: 0, t: t + 5 });
    expect(host.flick).toHaveBeenCalledTimes(1);
    const [vx, vy] = host.flick.mock.calls[0]!;
    // 10 px every 16 ms is about 10.4 px per 16.67 ms frame.
    expect(vx).toBeGreaterThan(8);
    expect(vx).toBeLessThan(13);
    expect(vy).toBe(0);
  });

  it('does not fling when the pointer rested before release', () => {
    const t = drag(5);
    pointer('pointerup', { x: 50, y: 0, t: t + 200 });
    const moved = host.flick.mock.calls.some(([vx, vy]) => vx !== 0 || vy !== 0);
    expect(moved).toBe(false);
  });

  it('never flings on pointercancel', () => {
    const t = drag(5);
    pointer('pointercancel', { x: 50, y: 0, t: t + 5 });
    expect(host.flick).not.toHaveBeenCalled();
  });

  it('ignores a right-button drag', () => {
    pointer('pointerdown', { x: 0, y: 0, t: 0, button: 2 });
    pointer('pointermove', { x: 30, y: 0, t: 16 });
    pointer('pointerup', { x: 30, y: 0, t: 20, button: 2 });
    expect(host.panByPixels).not.toHaveBeenCalled();
    expect(host.flick).not.toHaveBeenCalled();
  });

  it('pans a left-button drag by the pointer delta', () => {
    pointer('pointerdown', { x: 0, y: 0, t: 0 });
    pointer('pointermove', { x: 12, y: -4, t: 16 });
    expect(host.panByPixels).toHaveBeenCalledWith(12, -4);
  });

  it('pinches with two touch pointers and does not pan or fling from it', () => {
    const touch = { pointerType: 'touch' };
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    pointer('pointerdown', { x: 200, y: 100, t: 0, id: 2, ...touch });
    pointer('pointermove', { x: 300, y: 100, t: 16, id: 2, ...touch });
    // Distance 100 -> 200 halves the fov around the midpoint.
    expect(host.zoomAt).toHaveBeenCalledWith(0.5, 200, 100);
    pointer('pointerup', { x: 300, y: 100, t: 20, id: 2, ...touch });
    // The finger left over from the pinch must not pan.
    pointer('pointermove', { x: 150, y: 100, t: 32, id: 1, ...touch });
    pointer('pointerup', { x: 150, y: 100, t: 34, id: 1, ...touch });
    expect(host.panByPixels).not.toHaveBeenCalled();
    expect(host.flick).not.toHaveBeenCalled();
  });
});

function key(k: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) {
  return el.dispatch('keydown', {
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
}

describe('Controls: keyboard and accessibility', () => {
  it('zooms on a plain "=" and claims the key', () => {
    setup();
    const ev = key('=');
    expect(host.zoomAt).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('leaves Ctrl+= and Cmd+- to the browser', () => {
    setup();
    const a = key('=', { ctrlKey: true });
    const b = key('-', { metaKey: true });
    expect(a.defaultPrevented).toBe(false);
    expect(b.defaultPrevented).toBe(false);
    expect(host.zoomAt).not.toHaveBeenCalled();
  });

  it('leaves Alt+arrow to the browser', () => {
    setup();
    const ev = key('ArrowLeft', { altKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(host.panByPixels).not.toHaveBeenCalled();
  });

  it('gives the element a role, a default label, a tab stop and a grab cursor', () => {
    setup();
    expect(el.role).toBe('application');
    expect(el.ariaLabel).toBe('Panorama viewer');
    expect(el.tabIndex).toBe(0);
    expect(el.style.cursor).toBe('grab');
  });

  it('uses the label option for the accessible name', () => {
    setup({ label: 'Lobby panorama' });
    expect(el.ariaLabel).toBe('Lobby panorama');
  });
});

function wheel(init: {
  deltaY?: number;
  deltaX?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
}) {
  return el.dispatch('wheel', {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    clientX: 400,
    clientY: 300,
    ...init,
  });
}

/** The zoom factor of the only zoomAt call so far. */
function onlyZoom(): number {
  expect(host.zoomAt).toHaveBeenCalledTimes(1);
  return host.zoomAt.mock.calls[0]![0];
}

describe('Controls: wheel and trackpad', () => {
  it('zooms the same for 3 lines as for 48 pixels', () => {
    setup();
    wheel({ deltaMode: 1, deltaY: 3 });
    const lines = onlyZoom();
    setup();
    wheel({ deltaMode: 0, deltaY: 48 });
    const pixels = onlyZoom();
    expect(lines).toBeCloseTo(pixels, 10);
    expect(lines).toBeGreaterThan(1);
  });

  it('treats one page as the element height', () => {
    setup();
    el.rect.height = 100;
    wheel({ deltaMode: 2, deltaY: 1 });
    const page = onlyZoom();
    setup();
    wheel({ deltaMode: 0, deltaY: 100 });
    expect(page).toBeCloseTo(onlyZoom(), 10);
  });

  it('zooms a ctrl-wheel (trackpad pinch) much harder than a plain wheel', () => {
    setup();
    wheel({ deltaY: 5 });
    const plain = Math.abs(Math.log(onlyZoom()));
    setup();
    wheel({ deltaY: 5, ctrlKey: true });
    const pinch = Math.abs(Math.log(onlyZoom()));
    expect(pinch).toBeGreaterThan(plain * 5);
  });

  it('caps the zoom from one huge wheel event', () => {
    setup();
    wheel({ deltaY: 1000, ctrlKey: true });
    const z = onlyZoom();
    expect(z).toBeGreaterThan(1);
    expect(z).toBeLessThan(1.5);
  });

  it('pans on a horizontal swipe instead of zooming', () => {
    setup();
    const ev = wheel({ deltaX: 30 });
    expect(host.panByPixels).toHaveBeenCalledWith(-30, 0);
    expect(host.zoomAt).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it('zooms on a Safari pinch gesture and stops the page zooming', () => {
    setup();
    const start = el.dispatch('gesturestart', { scale: 1, clientX: 400, clientY: 300 });
    const change = el.dispatch('gesturechange', { scale: 2, clientX: 400, clientY: 300 });
    el.dispatch('gestureend', { scale: 2, clientX: 400, clientY: 300 });
    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(host.zoomAt).toHaveBeenCalledWith(0.5, 400, 300);
  });
});

describe('Controls: wheel capture mode', () => {
  it('captures every wheel by default', () => {
    setup();
    const ev = wheel({ deltaY: 100 });
    expect(ev.defaultPrevented).toBe(true);
    expect(host.zoomAt).toHaveBeenCalledTimes(1);
  });

  it("lets a plain wheel scroll the page in 'engaged' mode until the viewer is engaged", () => {
    setup({ wheel: 'engaged' });
    const down = wheel({ deltaY: 100 });
    const side = wheel({ deltaX: 40 });
    expect(down.defaultPrevented).toBe(false);
    expect(side.defaultPrevented).toBe(false);
    expect(host.zoomAt).not.toHaveBeenCalled();
    expect(host.panByPixels).not.toHaveBeenCalled();
  });

  it("zooms on ctrl or cmd + wheel in 'engaged' mode without engagement", () => {
    setup({ wheel: 'engaged' });
    const ctrl = wheel({ deltaY: 5, ctrlKey: true });
    const cmd = wheel({ deltaY: 100, metaKey: true });
    expect(ctrl.defaultPrevented).toBe(true);
    expect(cmd.defaultPrevented).toBe(true);
    expect(host.zoomAt).toHaveBeenCalledTimes(2);
  });

  it('captures the wheel after a pointerdown, until the pointer leaves', () => {
    setup({ wheel: 'engaged' });
    pointer('pointerdown', { x: 10, y: 10, t: 0 });
    pointer('pointerup', { x: 10, y: 10, t: 100 });
    const engaged = wheel({ deltaY: 100 });
    expect(engaged.defaultPrevented).toBe(true);
    expect(host.zoomAt).toHaveBeenCalledTimes(1);
    el.dispatch('pointerleave', { pointerId: 1 });
    const left = wheel({ deltaY: 100 });
    expect(left.defaultPrevented).toBe(false);
    expect(host.zoomAt).toHaveBeenCalledTimes(1);
  });

  it('captures the wheel while focused, until blur', () => {
    setup({ wheel: 'engaged' });
    el.dispatch('focus', {});
    expect(wheel({ deltaY: 100 }).defaultPrevented).toBe(true);
    el.dispatch('blur', {});
    expect(wheel({ deltaY: 100 }).defaultPrevented).toBe(false);
    expect(host.zoomAt).toHaveBeenCalledTimes(1);
  });

  it('removes the engagement listeners on dispose', () => {
    const c = setup({ wheel: 'engaged' });
    c.dispose();
    for (const type of ['wheel', 'focus', 'blur', 'pointerleave', 'gesturestart']) {
      expect(el.listeners.get(type)?.size ?? 0).toBe(0);
    }
  });
});
