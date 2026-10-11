import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Controls,
  WHEEL_GESTURE_GAP_MS,
  type ControlHost,
  type ControlsOptions,
} from './controls.js';

/**
 * Controls only needs a small slice of HTMLElement, so these tests run in Node
 * against a fake element and plain event objects instead of a DOM.
 */
type Listener = (e: unknown) => void;

class FakeElement {
  style: Record<string, string> = {};
  tabIndex = -1;
  listeners = new Map<string, Set<Listener>>();
  listenerOptions = new Map<string, unknown>();
  rect = { left: 0, top: 0, width: 800, height: 600 };

  addEventListener(type: string, fn: Listener, options?: unknown) {
    this.listenerOptions.set(type, options);
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
    panTargetByPixels: vi.fn<ControlHost['panTargetByPixels']>(),
    zoomAt: vi.fn<ControlHost['zoomAt']>(),
    pinchStart: vi.fn<ControlHost['pinchStart']>(),
    pinchTo: vi.fn<ControlHost['pinchTo']>(),
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
  init: {
    x: number;
    y: number;
    t: number;
    id?: number;
    button?: number;
    buttons?: number;
    pointerType?: string;
  },
) {
  return el.dispatch(type, {
    pointerId: init.id ?? 1,
    pointerType: init.pointerType ?? 'mouse',
    button: init.button ?? 0,
    // Held while dragging: the left button, or a touch or pen in contact.
    buttons: init.buttons ?? 1,
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

  it('releases on lostpointercapture, so the next press starts a fresh drag', () => {
    pointer('pointerdown', { x: 100, y: 0, t: 0 });
    pointer('pointermove', { x: 120, y: 0, t: 16 });
    // Capture lost (the canvas re-parented, a browser takeover) with no pointerup.
    pointer('lostpointercapture', { x: 120, y: 0, t: 20 });
    // The next press starts a fresh drag from where it lands, with no jump.
    pointer('pointerdown', { x: 600, y: 0, t: 60 });
    pointer('pointermove', { x: 601, y: 0, t: 76 });
    expect(host.panByPixels.mock.calls).toEqual([
      [20, 0],
      [1, 0],
    ]);
    expect(host.flick).not.toHaveBeenCalled();
    expect(el.style['cursor']).toBe('grabbing');
  });

  it('treats a mouse move with no button held as a missed pointerup', () => {
    pointer('pointerdown', { x: 100, y: 0, t: 0 });
    pointer('pointermove', { x: 120, y: 0, t: 16 });
    pointer('pointermove', { x: 400, y: 0, t: 40, buttons: 0 });
    expect(el.style['cursor']).toBe('grab');
    pointer('pointerdown', { x: 600, y: 0, t: 60 });
    pointer('pointermove', { x: 601, y: 0, t: 76 });
    expect(host.panByPixels.mock.calls).toEqual([
      [20, 0],
      [1, 0],
    ]);
    expect(host.flick).not.toHaveBeenCalled();
  });

  it('removes the lostpointercapture listener on dispose', () => {
    const controls = setup();
    controls.dispose();
    expect(el.listeners.get('lostpointercapture')?.size ?? 0).toBe(0);
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

  it('pinches with two touch pointers, drags on with the finger left, and never flings', () => {
    const touch = { pointerType: 'touch' };
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    pointer('pointerdown', { x: 200, y: 100, t: 0, id: 2, ...touch });
    expect(host.pinchStart).toHaveBeenCalledWith(150, 100);
    pointer('pointermove', { x: 300, y: 100, t: 16, id: 2, ...touch });
    // Distance 100 -> 200 halves the start fov, about the moved midpoint.
    expect(host.pinchTo).toHaveBeenCalledWith(0.5, 200, 100);
    expect(host.zoomAt).not.toHaveBeenCalled();
    pointer('pointerup', { x: 300, y: 100, t: 20, id: 2, ...touch });
    // The finger left drags on from where it is, with no jump.
    pointer('pointermove', { x: 150, y: 100, t: 32, id: 1, ...touch });
    expect(host.panByPixels).toHaveBeenCalledWith(50, 0);
    pointer('pointerup', { x: 150, y: 100, t: 34, id: 1, ...touch });
    expect(host.flick).not.toHaveBeenCalled();
  });
});

function key(
  k: string,
  mods: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    getModifierState?: (key: string) => boolean;
  } = {},
) {
  return el.dispatch('keydown', {
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
}

describe('Controls: keyboard and focus', () => {
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
    expect(host.panTargetByPixels).not.toHaveBeenCalled();
  });

  it('gives the element a tab stop and a grab cursor', () => {
    setup();
    expect(el.tabIndex).toBe(0);
    expect(el.style.cursor).toBe('grab');
  });
});

function wheel(init: {
  deltaY?: number;
  deltaX?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  timeStamp?: number;
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

  it('zooms only on a mostly vertical scroll, dropping its sideways jitter', () => {
    setup();
    wheel({ deltaY: -40, deltaX: 12 });
    wheel({ deltaY: 6, deltaX: -6 }); // a tie goes to the zoom
    expect(host.zoomAt).toHaveBeenCalledTimes(2);
    expect(host.panByPixels).not.toHaveBeenCalled();
  });

  it('pans only on a mostly horizontal swipe, without zooming', () => {
    setup();
    wheel({ deltaX: 30, deltaY: 8 });
    expect(host.panByPixels).toHaveBeenCalledWith(-30, 0);
    expect(host.zoomAt).not.toHaveBeenCalled();
  });

  it('compares the axes in pixels, after line and page deltas are scaled', () => {
    setup();
    wheel({ deltaX: 3, deltaY: 1, deltaMode: 1 });
    expect(host.panByPixels).toHaveBeenCalledWith(-48, 0);
    expect(host.zoomAt).not.toHaveBeenCalled();
  });

  it('zooms on a ctrl-wheel pinch whatever its deltaX, and never pans', () => {
    setup();
    wheel({ deltaX: 30, deltaY: 5, ctrlKey: true });
    expect(host.zoomAt).toHaveBeenCalledTimes(1);
    expect(host.panByPixels).not.toHaveBeenCalled();
  });

  describe('one axis per wheel gesture', () => {
    it('keeps zooming through a tail whose sideways jitter outgrows it', () => {
      setup();
      for (let i = 0; i < 30; i++) wheel({ deltaY: -30 * 0.85 ** i, deltaX: 2, timeStamp: i * 16 });
      expect(host.zoomAt).toHaveBeenCalledTimes(30);
      expect(host.panByPixels).not.toHaveBeenCalled();
    });

    it('keeps panning through a swipe whose vertical jitter outgrows it', () => {
      setup();
      for (let i = 0; i < 30; i++)
        wheel({ deltaX: 30 * 0.85 ** i, deltaY: 1.5, timeStamp: i * 16 });
      expect(host.panByPixels).toHaveBeenCalledTimes(30);
      expect(host.zoomAt).not.toHaveBeenCalled();
    });

    it(`picks the axis again after a pause of more than ${WHEEL_GESTURE_GAP_MS} ms`, () => {
      setup();
      wheel({ deltaY: -30, deltaX: 1, timeStamp: 0 });
      // Within the gap, a sideways event is still the zoom gesture's.
      wheel({ deltaY: 0.5, deltaX: 20, timeStamp: WHEEL_GESTURE_GAP_MS });
      expect(host.panByPixels).not.toHaveBeenCalled();
      expect(host.zoomAt).toHaveBeenCalledTimes(2);
      // After a longer pause it is a new gesture, picked by its own axes.
      wheel({ deltaY: 0.5, deltaX: 20, timeStamp: 2 * WHEEL_GESTURE_GAP_MS + 1 });
      expect(host.panByPixels).toHaveBeenCalledWith(-20, 0);
      expect(host.zoomAt).toHaveBeenCalledTimes(2);
    });

    it('lets the first event with a delta pick the axis', () => {
      setup();
      wheel({ timeStamp: 0 });
      wheel({ deltaX: 20, deltaY: 1, timeStamp: 16 });
      expect(host.panByPixels).toHaveBeenCalledWith(-20, 0);
    });

    it('always zooms on a ctrl-wheel, and starts a new gesture when ctrl changes', () => {
      setup();
      wheel({ deltaY: 1, deltaX: 30, ctrlKey: true, timeStamp: 0 });
      expect(host.zoomAt).toHaveBeenCalledTimes(1);
      // Ctrl let go within the gap: a new gesture, here a sideways pan.
      wheel({ deltaY: 1, deltaX: 30, timeStamp: 16 });
      expect(host.panByPixels).toHaveBeenCalledWith(-30, 0);
      // And held again: a pinch, which zooms and never pans.
      wheel({ deltaY: 1, deltaX: 30, ctrlKey: true, timeStamp: 32 });
      expect(host.zoomAt).toHaveBeenCalledTimes(2);
      expect(host.panByPixels).toHaveBeenCalledTimes(1);
    });
  });

  it('zooms on a Safari pinch gesture and stops the page zooming', () => {
    setup();
    const start = el.dispatch('gesturestart', { scale: 1, clientX: 400, clientY: 300 });
    const change = el.dispatch('gesturechange', { scale: 2, clientX: 400, clientY: 300 });
    el.dispatch('gestureend', { scale: 2, clientX: 400, clientY: 300 });
    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(host.pinchStart).toHaveBeenCalledWith(400, 300);
    expect(host.pinchTo).toHaveBeenCalledWith(0.5, 400, 300);
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
    el.dispatch('pointerleave', { pointerId: 1, pointerType: 'mouse' });
    const left = wheel({ deltaY: 100 });
    expect(left.defaultPrevented).toBe(false);
    expect(host.zoomAt).toHaveBeenCalledTimes(1);
  });

  it('stays engaged when a touch or pen pointer leaves', () => {
    setup({ wheel: 'engaged' });
    pointer('pointerdown', { x: 10, y: 10, t: 0, pointerType: 'touch' });
    pointer('pointerup', { x: 10, y: 10, t: 100, pointerType: 'touch' });
    el.dispatch('pointerleave', { pointerId: 1, pointerType: 'touch' });
    el.dispatch('pointerleave', { pointerId: 2, pointerType: 'pen' });
    expect(wheel({ deltaY: 100 }).defaultPrevented).toBe(true);
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

describe('Controls: gesture events next to a touch pinch (iOS Safari)', () => {
  const touch = { pointerType: 'touch' };

  it('lets the pointer pinch drive the zoom and only claims the gesture events', () => {
    setup();
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    pointer('pointerdown', { x: 200, y: 100, t: 0, id: 2, ...touch });
    const start = el.dispatch('gesturestart', { scale: 1, clientX: 150, clientY: 100 });
    const change = el.dispatch('gesturechange', { scale: 2, clientX: 200, clientY: 100 });
    pointer('pointermove', { x: 300, y: 100, t: 16, id: 2, ...touch });
    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(host.pinchStart).toHaveBeenCalledTimes(1);
    expect(host.pinchTo).toHaveBeenCalledTimes(1);
    expect(host.pinchTo).toHaveBeenCalledWith(0.5, 200, 100);
  });

  it('does not start a gesture zoom while a pointer is tracked', () => {
    setup();
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    pointer('pointerdown', { x: 200, y: 100, t: 0, id: 2, ...touch });
    el.dispatch('gesturestart', { scale: 1, clientX: 150, clientY: 100 });
    pointer('pointerup', { x: 100, y: 100, t: 16, id: 1, ...touch });
    pointer('pointerup', { x: 200, y: 100, t: 16, id: 2, ...touch });
    // A late gesturechange after the fingers lifted has no gesture to scale.
    el.dispatch('gesturechange', { scale: 2, clientX: 150, clientY: 100 });
    expect(host.pinchTo).not.toHaveBeenCalled();
  });

  it('does not zoom a gesture change once pointers are tracked', () => {
    setup();
    // Gesture first (event order is not guaranteed), then the fingers land.
    el.dispatch('gesturestart', { scale: 1, clientX: 150, clientY: 100 });
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    pointer('pointerdown', { x: 200, y: 100, t: 0, id: 2, ...touch });
    const change = el.dispatch('gesturechange', { scale: 2, clientX: 150, clientY: 100 });
    expect(change.defaultPrevented).toBe(true);
    expect(host.pinchTo).not.toHaveBeenCalled();
  });

  it('falls back to the element centre when a gesture has no coordinates', () => {
    setup();
    el.dispatch('gesturestart', { scale: 1 });
    el.dispatch('gesturechange', { scale: 2 });
    expect(host.pinchStart).toHaveBeenCalledWith(400, 300);
    expect(host.pinchTo).toHaveBeenCalledWith(0.5, 400, 300);
    for (const args of host.pinchTo.mock.calls) {
      expect(args.every((n) => Number.isFinite(n))).toBe(true);
    }
  });
});

describe('Controls: modifier edge cases', () => {
  it('zooms ctrl plus a mouse notch like a plain notch, not at pinch gain', () => {
    setup();
    wheel({ deltaY: 100, ctrlKey: true });
    const ctrlNotch = onlyZoom();
    setup();
    wheel({ deltaY: 100 });
    expect(ctrlNotch).toBeCloseTo(onlyZoom(), 10);
  });

  it('zooms a ctrl line-mode wheel at the plain gain', () => {
    setup();
    wheel({ deltaY: 3, deltaMode: 1, ctrlKey: true });
    const ctrlLines = onlyZoom();
    setup();
    wheel({ deltaY: 48 });
    expect(ctrlLines).toBeCloseTo(onlyZoom(), 10);
  });

  it('does not treat AltGr (reported as Ctrl+Alt) as a modifier', () => {
    setup();
    const ev = key('+', {
      ctrlKey: true,
      altKey: true,
      getModifierState: (k: string) => k === 'AltGraph',
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(host.zoomAt).toHaveBeenCalledTimes(1);
  });

  it('leaves Cmd to the browser even alongside AltGr', () => {
    setup();
    const ev = key('+', {
      metaKey: true,
      ctrlKey: true,
      altKey: true,
      getModifierState: (k: string) => k === 'AltGraph',
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(host.zoomAt).not.toHaveBeenCalled();
  });
});

describe('Controls: remaining branches', () => {
  const touch = { pointerType: 'touch' };

  it('moves the target 40 px on a plain ArrowLeft and claims the key', () => {
    setup();
    const ev = key('ArrowLeft');
    expect(host.panTargetByPixels).toHaveBeenCalledWith(40, 0);
    // The camera itself is left to ease after the target.
    expect(host.panByPixels).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it('moves the target on the other arrows too', () => {
    setup();
    key('ArrowRight');
    key('ArrowUp');
    key('ArrowDown');
    expect(host.panTargetByPixels.mock.calls).toEqual([
      [-40, 0],
      [0, 40],
      [0, -40],
    ]);
  });

  it('ignores a ctrl-wheel while a Safari gesture is in progress', () => {
    setup();
    el.dispatch('gesturestart', { scale: 1, clientX: 400, clientY: 300 });
    const ev = wheel({ deltaY: 5, ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(host.zoomAt).not.toHaveBeenCalled();
  });

  it('does not pan on the deltaX of a ctrl-wheel', () => {
    setup();
    wheel({ deltaX: 30, ctrlKey: true });
    expect(host.panByPixels).not.toHaveBeenCalled();
  });

  it('registers the wheel listener as non-passive so it can preventDefault', () => {
    setup();
    expect(el.listenerOptions.get('wheel')).toEqual({ passive: false });
  });

  it('ignores a third finger during a pinch', () => {
    setup();
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    pointer('pointerdown', { x: 200, y: 100, t: 0, id: 2, ...touch });
    pointer('pointerdown', { x: 500, y: 500, t: 0, id: 3, ...touch });
    pointer('pointermove', { x: 600, y: 600, t: 16, id: 3, ...touch });
    pointer('pointerup', { x: 600, y: 600, t: 20, id: 3, ...touch });
    expect(host.pinchTo).not.toHaveBeenCalled();
    expect(host.panByPixels).not.toHaveBeenCalled();
    // The first two fingers still pinch normally.
    pointer('pointermove', { x: 300, y: 100, t: 32, id: 2, ...touch });
    expect(host.pinchTo).toHaveBeenCalledWith(0.5, 200, 100);
  });

  it('drags on when the first finger lifts, and starts a new pinch when one lands', () => {
    setup();
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    pointer('pointerdown', { x: 200, y: 100, t: 0, id: 2, ...touch });
    pointer('pointerup', { x: 100, y: 100, t: 16, id: 1, ...touch });
    // The finger left drags on from where it is.
    pointer('pointermove', { x: 210, y: 100, t: 24, id: 2, ...touch });
    expect(host.panByPixels).toHaveBeenCalledTimes(1);
    expect(host.panByPixels).toHaveBeenCalledWith(10, 0);
    // A new finger 100 px away starts a new pinch; spreading to 200 px
    // halves the fov it started at.
    pointer('pointerdown', { x: 310, y: 100, t: 32, id: 3, ...touch });
    expect(host.pinchStart).toHaveBeenLastCalledWith(260, 100);
    pointer('pointermove', { x: 410, y: 100, t: 48, id: 3, ...touch });
    expect(host.pinchTo).toHaveBeenCalledTimes(1);
    expect(host.pinchTo).toHaveBeenCalledWith(0.5, 310, 100);
    pointer('pointerup', { x: 410, y: 100, t: 56, id: 3, ...touch });
    pointer('pointerup', { x: 210, y: 100, t: 56, id: 2, ...touch });
    expect(host.panByPixels).toHaveBeenCalledTimes(1);
    expect(host.flick).not.toHaveBeenCalled();
  });
});

describe('Controls: interaction options', () => {
  it('scales a plain wheel by wheelGain and a pinch by pinchGain', () => {
    setup({ wheelGain: 0.002 });
    wheel({ deltaY: 50 });
    expect(Math.log(onlyZoom())).toBeCloseTo(0.1, 10);
    setup({ pinchGain: 0.02 });
    wheel({ deltaY: 5, ctrlKey: true });
    expect(Math.log(onlyZoom())).toBeCloseTo(0.1, 10);
  });

  it("ignores the wheel entirely with wheel: 'off'", () => {
    setup({ wheel: 'off' });
    const plain = wheel({ deltaY: 50 });
    const pinch = wheel({ deltaY: 5, ctrlKey: true });
    expect(plain.defaultPrevented).toBe(false);
    expect(pinch.defaultPrevented).toBe(false);
    expect(host.zoomAt).not.toHaveBeenCalled();
  });

  it('steps the keys by keyboard.panStepPx and zoomStep (and its inverse)', () => {
    setup({ keyboard: { panStepPx: 10, zoomStep: 0.5 } });
    key('ArrowLeft');
    expect(host.panTargetByPixels).toHaveBeenCalledWith(10, 0);
    key('=');
    key('-');
    expect(host.zoomAt.mock.calls.map(([s]) => s)).toEqual([0.5, 2]);
  });

  it('fills an unset keyboard field from the defaults', () => {
    setup({ keyboard: { zoomStep: 0.5 } });
    key('ArrowUp');
    expect(host.panTargetByPixels).toHaveBeenCalledWith(0, 40);
  });

  it('ignores keys, and gives no tab stop, with keyboard: false', () => {
    setup({ keyboard: false });
    const ev = key('ArrowLeft');
    expect(ev.defaultPrevented).toBe(false);
    expect(host.panTargetByPixels).not.toHaveBeenCalled();
    expect(el.tabIndex).toBe(-1);
  });

  it('zooms a double click by doubleClickZoom, or not at all with false', () => {
    setup({ doubleClickZoom: 0.5 });
    el.dispatch('dblclick', { clientX: 10, clientY: 20 });
    expect(host.zoomAt).toHaveBeenCalledWith(0.5, 10, 20);
    setup();
    el.dispatch('dblclick', { clientX: 10, clientY: 20 });
    expect(host.zoomAt).toHaveBeenCalledWith(0.6, 10, 20);
    setup({ doubleClickZoom: false });
    const ev = el.dispatch('dblclick', { clientX: 10, clientY: 20 });
    expect(ev.defaultPrevented).toBe(false);
    expect(host.zoomAt).not.toHaveBeenCalled();
  });

  it('does not fling with inertia: false', () => {
    setup({ inertia: false });
    const t = drag(5);
    pointer('pointerup', { x: 50, y: 0, t: t + 5 });
    expect(host.flick).not.toHaveBeenCalled();
  });

  it('leaves the cursor alone with cursor: false', () => {
    setup({ cursor: false });
    pointer('pointerdown', { x: 0, y: 0, t: 0 });
    expect(el.style.cursor).toBeUndefined();
  });
});
