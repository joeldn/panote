import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { Controls, PINCH_ARM_MS, WHEEL_GESTURE_GAP_MS, type ControlHost } from './controls.js';
import { resolveViewerOptions } from './defaults.js';
import type { InteractionOptions } from './types.js';

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
    dragStart: vi.fn<ControlHost['dragStart']>(),
    dragBy: vi.fn<ControlHost['dragBy']>(),
    dragEnd: vi.fn<ControlHost['dragEnd']>(),
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

/** Controls with `opts` resolved over the defaults, as the viewer builds it. */
function setup(opts: InteractionOptions = {}) {
  el = new FakeElement();
  host = makeHost();
  const { interaction } = resolveViewerOptions({ interaction: opts });
  return new Controls(el as unknown as HTMLElement, host, interaction);
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
    isPrimary?: boolean;
  },
) {
  return el.dispatch(type, {
    pointerId: init.id ?? 1,
    pointerType: init.pointerType ?? 'mouse',
    isPrimary: init.isPrimary,
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

  it('tracks the drag in one object, allocating nothing per pointermove', () => {
    const controls = setup();
    pointer('pointerdown', { x: 0, y: 0, t: 0 });
    const last = (controls as unknown as { last: object }).last;
    for (let i = 1; i <= 5; i++) pointer('pointermove', { x: i * 10, y: i, t: i * 16 });
    pointer('pointerup', { x: 50, y: 5, t: 85 });
    pointer('pointerdown', { x: 7, y: 7, t: 200 });
    expect((controls as unknown as { last: object }).last).toBe(last);
    expect(last).toEqual({ x: 7, y: 7 });
    expect(host.dragBy.mock.calls).toEqual([
      [10, 1, 16],
      [10, 1, 32],
      [10, 1, 48],
      [10, 1, 64],
      [10, 1, 80],
    ]);
  });

  it('never flings on pointercancel', () => {
    const t = drag(5);
    pointer('pointercancel', { x: 50, y: 0, t: t + 5 });
    expect(host.flick).not.toHaveBeenCalled();
  });

  it('releases on lostpointercapture, so the next press starts a fresh drag', () => {
    pointer('pointerdown', { x: 100, y: 0, t: 0 });
    pointer('pointermove', { x: 120, y: 0, t: 16 });
    // Capture lost (the canvas re-parented, a browser takeover) with no
    // pointerup, after the pointer had come to rest.
    pointer('lostpointercapture', { x: 120, y: 0, t: 200 });
    // The next press starts a fresh drag from where it lands, with no jump.
    pointer('pointerdown', { x: 600, y: 0, t: 260 });
    pointer('pointermove', { x: 601, y: 0, t: 276 });
    expect(host.dragStart.mock.calls).toEqual([[0], [260]]);
    expect(host.dragBy.mock.calls).toEqual([
      [20, 0, 16],
      [1, 0, 276],
    ]);
    expect(host.flick.mock.calls).toEqual([[0, 0]]);
    expect(el.style['cursor']).toBe('grabbing');
  });

  it('treats a mouse move with no button held as a missed pointerup', () => {
    pointer('pointerdown', { x: 100, y: 0, t: 0 });
    pointer('pointermove', { x: 120, y: 0, t: 16 });
    // A hover long after the last drag move: the pointerup went missing.
    pointer('pointermove', { x: 400, y: 0, t: 400, buttons: 0 });
    expect(el.style['cursor']).toBe('grab');
    pointer('pointerdown', { x: 600, y: 0, t: 460 });
    pointer('pointermove', { x: 601, y: 0, t: 476 });
    expect(host.dragBy.mock.calls).toEqual([
      [20, 0, 16],
      [1, 0, 476],
    ]);
    expect(host.flick.mock.calls).toEqual([[0, 0]]);
  });

  it.each(['touch', 'pen'])('keeps dragging a %s that reports no buttons', (pointerType) => {
    // Only a mouse move with no button held means a missed pointerup.
    pointer('pointerdown', { x: 100, y: 0, t: 0, pointerType });
    pointer('pointermove', { x: 120, y: 0, t: 16, pointerType, buttons: 0 });
    pointer('pointermove', { x: 150, y: 0, t: 32, pointerType, buttons: 0 });
    expect(host.dragBy.mock.calls).toEqual([
      [20, 0, 16],
      [30, 0, 32],
    ]);
    expect(el.style['cursor']).toBe('grabbing');
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
    expect(host.dragStart).not.toHaveBeenCalled();
    expect(host.dragBy).not.toHaveBeenCalled();
    expect(host.flick).not.toHaveBeenCalled();
  });

  it('drags by the pointer delta, timestamped, from a left-button press', () => {
    pointer('pointerdown', { x: 0, y: 0, t: 0 });
    pointer('pointermove', { x: 12, y: -4, t: 16 });
    expect(host.dragStart).toHaveBeenCalledWith(0);
    expect(host.dragBy).toHaveBeenCalledWith(12, -4, 16);
    expect(host.panByPixels).not.toHaveBeenCalled();
  });

  it('ends the drag before it flings, so the glide takes over what is left of it', () => {
    const t = drag(5);
    pointer('pointerup', { x: 50, y: 0, t: t + 5 });
    expect(host.dragEnd).toHaveBeenCalledTimes(1);
    expect(host.dragEnd.mock.invocationCallOrder[0]!).toBeLessThan(
      host.flick.mock.invocationCallOrder[0]!,
    );
  });

  it('pinches with two touch pointers, drags on with the finger left, and never flings', () => {
    const touch = { pointerType: 'touch' };
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    pointer('pointerdown', { x: 200, y: 100, t: 0, id: 2, ...touch });
    expect(host.dragEnd).not.toHaveBeenCalled();
    pointer('pointermove', { x: 300, y: 100, t: 60, id: 2, ...touch });
    // Once both have been down a moment, the pinch takes over from the first
    // finger's drag, where it is, from where the fingers were.
    expect(host.dragEnd.mock.calls).toEqual([[true]]);
    expect(host.pinchStart).toHaveBeenCalledWith(150, 100);
    // Distance 100 -> 200 halves the start fov, about the moved midpoint.
    expect(host.pinchTo).toHaveBeenCalledWith(0.5, 200, 100);
    expect(host.zoomAt).not.toHaveBeenCalled();
    pointer('pointerup', { x: 300, y: 100, t: 64, id: 2, ...touch });
    // The finger left drags on from where it is, with no jump.
    pointer('pointermove', { x: 150, y: 100, t: 76, id: 1, ...touch });
    expect(host.dragStart).toHaveBeenLastCalledWith(64);
    expect(host.dragBy).toHaveBeenCalledWith(50, 0, 76);
    pointer('pointerup', { x: 150, y: 100, t: 78, id: 1, ...touch });
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
    pointer('pointermove', { x: 300, y: 100, t: 60, id: 2, ...touch });
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
    expect(host.dragBy).not.toHaveBeenCalled();
    // The first two fingers still pinch normally.
    pointer('pointermove', { x: 300, y: 100, t: 60, id: 2, ...touch });
    expect(host.pinchTo).toHaveBeenCalledWith(0.5, 200, 100);
  });

  it('drags on when the first finger lifts, and starts a new pinch when one lands', () => {
    setup();
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    pointer('pointerdown', { x: 200, y: 100, t: 0, id: 2, ...touch });
    pointer('pointerup', { x: 100, y: 100, t: 16, id: 1, ...touch });
    // The finger left drags on from where it is.
    pointer('pointermove', { x: 210, y: 100, t: 24, id: 2, ...touch });
    expect(host.dragBy).toHaveBeenCalledTimes(1);
    expect(host.dragBy).toHaveBeenCalledWith(10, 0, 24);
    // A new finger 100 px away starts a new pinch; spreading to 200 px
    // halves the fov it started at.
    pointer('pointerdown', { x: 310, y: 100, t: 32, id: 3, ...touch });
    pointer('pointermove', { x: 410, y: 100, t: 88, id: 3, ...touch });
    expect(host.pinchStart).toHaveBeenLastCalledWith(260, 100);
    expect(host.pinchTo).toHaveBeenCalledTimes(1);
    expect(host.pinchTo).toHaveBeenCalledWith(0.5, 310, 100);
    pointer('pointerup', { x: 410, y: 100, t: 96, id: 3, ...touch });
    pointer('pointerup', { x: 210, y: 100, t: 96, id: 2, ...touch });
    expect(host.dragBy).toHaveBeenCalledTimes(1);
    expect(host.flick).not.toHaveBeenCalled();
  });
});

describe('Controls: touch bookkeeping (iOS Safari)', () => {
  const touch = { pointerType: 'touch' };
  const touches = (type: string, length: number) => el.dispatch(type, { touches: { length } });

  beforeEach(() => {
    setup();
  });

  it('forgets a finger whose pointerup was lost when the next one lands as primary', () => {
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, isPrimary: true, ...touch });
    pointer('pointermove', { x: 150, y: 100, t: 16, id: 1, ...touch });
    // No pointerup for finger 1. The next touch is primary: nothing else is down.
    pointer('pointerdown', { x: 300, y: 300, t: 500, id: 2, isPrimary: true, ...touch });
    pointer('pointermove', { x: 340, y: 300, t: 600, id: 2, ...touch });
    expect(host.pinchStart).not.toHaveBeenCalled();
    expect(host.pinchTo).not.toHaveBeenCalled();
    expect(host.dragBy).toHaveBeenLastCalledWith(40, 0, 600);
    // The forgotten drag is caught up at once and never flings.
    expect(host.dragEnd).toHaveBeenCalledWith(true);
    expect(host.flick).not.toHaveBeenCalled();
  });

  it('forgets a touch pointer still tracked 100 ms after the touches say no finger is down', () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    touches('touchstart', 1);
    pointer('pointerdown', { x: 200, y: 100, t: 8, id: 2, ...touch });
    touches('touchstart', 2);
    pointer('pointerup', { x: 100, y: 100, t: 100, id: 1, ...touch });
    touches('touchend', 1);
    // Finger 2's pointerup is lost; its touchend still comes.
    touches('touchend', 0);
    expect(el.style['cursor']).toBe('grabbing');
    vi.advanceTimersByTime(100);
    expect(el.style['cursor']).toBe('grab');
    pointer('pointerdown', { x: 300, y: 300, t: 500, id: 3, ...touch });
    pointer('pointermove', { x: 340, y: 300, t: 600, id: 3, ...touch });
    expect(host.pinchTo).not.toHaveBeenCalled();
    expect(host.dragBy).toHaveBeenLastCalledWith(40, 0, 600);
  });

  it('does not pinch a mouse pressed just after a touch whose pointerup was lost', () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, isPrimary: true, ...touch });
    touches('touchstart', 1);
    pointer('pointermove', { x: 150, y: 100, t: 16, id: 1, ...touch });
    // Finger 1's pointerup is lost; its touchend still comes.
    touches('touchend', 0);
    // A touchscreen laptop: the mouse is pressed before the prune is due.
    vi.advanceTimersByTime(10);
    pointer('pointerdown', { x: 400, y: 300, t: 30, id: 7, isPrimary: true });
    pointer('pointermove', { x: 420, y: 300, t: 90, id: 7 });
    vi.advanceTimersByTime(100);
    pointer('pointermove', { x: 450, y: 300, t: 140, id: 7 });
    expect(host.pinchStart).not.toHaveBeenCalled();
    expect(host.pinchTo).not.toHaveBeenCalled();
    expect(host.dragBy.mock.calls.slice(-2)).toEqual([
      [20, 0, 90],
      [30, 0, 140],
    ]);
    pointer('pointerup', { x: 450, y: 300, t: 144, id: 7, buttons: 0 });
    expect(host.flick).toHaveBeenCalledTimes(1);
  });

  it('forgets a lost touch by 100 ms though a non-primary touch lands in the meantime', () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, isPrimary: true, ...touch });
    touches('touchstart', 1);
    // Finger 1's pointerup is lost; its touchend still comes.
    touches('touchend', 0);
    vi.advanceTimersByTime(20);
    pointer('pointerdown', { x: 300, y: 300, t: 20, id: 2, isPrimary: false, ...touch });
    touches('touchstart', 1);
    vi.advanceTimersByTime(100);
    expect(host.dragEnd).toHaveBeenCalledWith(true);
    // Finger 2 drags on alone, and nothing pinches.
    pointer('pointermove', { x: 340, y: 300, t: 130, id: 2, ...touch });
    expect(host.pinchStart).not.toHaveBeenCalled();
    expect(host.pinchTo).not.toHaveBeenCalled();
    expect(host.dragBy).toHaveBeenLastCalledWith(40, 0, 130);
  });

  it('never forgets a finger pressed after the touches said none was down, even with the same id', () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, isPrimary: true, ...touch });
    touches('touchstart', 1);
    pointer('pointermove', { x: 160, y: 100, t: 16, id: 1, ...touch });
    // The touchend comes first; the pointerup after it still releases.
    touches('touchend', 0);
    pointer('pointerup', { x: 160, y: 100, t: 20, id: 1, buttons: 0, ...touch });
    expect(host.flick).toHaveBeenCalledTimes(1);
    // A new finger, with the id the last one had, lands before the timer is due.
    pointer('pointerdown', { x: 200, y: 200, t: 40, id: 1, isPrimary: true, ...touch });
    touches('touchstart', 1);
    vi.advanceTimersByTime(100);
    expect(host.dragEnd).toHaveBeenCalledTimes(1);
    pointer('pointermove', { x: 230, y: 200, t: 150, id: 1, ...touch });
    expect(host.dragBy).toHaveBeenLastCalledWith(30, 0, 150);
    expect(el.style['cursor']).toBe('grabbing');
  });

  it('clears the pending prune on dispose', () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const controls = setup();
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    touches('touchend', 0);
    controls.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps tracking when a touchend leaves a finger down', () => {
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    touches('touchend', 1);
    pointer('pointermove', { x: 120, y: 100, t: 16, id: 1, ...touch });
    expect(host.dragBy).toHaveBeenCalledWith(20, 0, 16);
  });

  it(`hands the drag over, without pinching, to a finger that lands under ${PINCH_ARM_MS} ms before the last lifts`, () => {
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    pointer('pointermove', { x: 160, y: 100, t: 16, id: 1, ...touch });
    pointer('pointerdown', { x: 120, y: 110, t: 24, id: 2, ...touch });
    // The first finger drags on meanwhile; the second only keeps its place.
    pointer('pointermove', { x: 190, y: 100, t: 32, id: 1, ...touch });
    pointer('pointermove', { x: 170, y: 110, t: 40, id: 2, ...touch });
    pointer('pointerup', { x: 190, y: 100, t: 48, id: 1, ...touch });
    expect(host.pinchStart).not.toHaveBeenCalled();
    expect(host.pinchTo).not.toHaveBeenCalled();
    // The new finger takes the same drag over from where it is, with no
    // jump, and its release flings like any drag's.
    for (let i = 1; i <= 4; i++) {
      pointer('pointermove', { x: 170 + i * 20, y: 110, t: 48 + i * 16, id: 2, ...touch });
    }
    expect(host.dragBy.mock.calls).toEqual([
      [60, 0, 16],
      [30, 0, 32],
      [20, 0, 64],
      [20, 0, 80],
      [20, 0, 96],
      [20, 0, 112],
    ]);
    expect(host.dragStart).toHaveBeenCalledTimes(1);
    expect(host.dragEnd).not.toHaveBeenCalled();
    pointer('pointerup', { x: 250, y: 110, t: 116, id: 2, ...touch });
    expect(host.flick).toHaveBeenCalledTimes(1);
    expect(host.flick.mock.calls[0]![0]).toBeGreaterThan(15);
  });

  it('drags on with the first finger when a second taps it for under the pinch delay', () => {
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    pointer('pointerdown', { x: 300, y: 300, t: 10, id: 2, ...touch });
    pointer('pointerup', { x: 300, y: 300, t: 30, id: 2, ...touch });
    for (let i = 1; i <= 4; i++) {
      pointer('pointermove', { x: 100 + i * 20, y: 100, t: 30 + i * 16, id: 1, ...touch });
    }
    expect(host.dragBy).toHaveBeenLastCalledWith(20, 0, 94);
    pointer('pointerup', { x: 180, y: 100, t: 98, id: 1, ...touch });
    expect(host.flick).toHaveBeenCalledTimes(1);
  });

  it('keeps a touch drag going through a pen or mouse press', () => {
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 5, isPrimary: true, ...touch });
    // Each pointer type has its own primary pointer.
    pointer('pointerdown', { x: 400, y: 400, t: 20, id: 9, isPrimary: true, pointerType: 'pen' });
    pointer('pointerup', { x: 400, y: 400, t: 30, id: 9, pointerType: 'pen' });
    pointer('pointermove', { x: 130, y: 100, t: 46, id: 5, ...touch });
    expect(host.dragBy).toHaveBeenLastCalledWith(30, 0, 46);
    expect(host.dragEnd).not.toHaveBeenCalled();
  });

  it('starts the pinch from where the fingers are once both have been down long enough', () => {
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    pointer('pointerdown', { x: 200, y: 100, t: 10, id: 2, ...touch });
    pointer('pointermove', { x: 250, y: 100, t: 30, id: 2, ...touch });
    expect(host.pinchTo).not.toHaveBeenCalled();
    // The move that starts it is its first step: 150 -> 200 px apart.
    pointer('pointermove', { x: 300, y: 100, t: 62, id: 2, ...touch });
    expect(host.pinchStart.mock.calls).toEqual([[175, 100]]);
    expect(host.pinchTo.mock.calls).toEqual([[0.75, 200, 100]]);
  });

  it('claims but never zooms on gesture events while a finger is down', () => {
    touches('touchstart', 2);
    const start = el.dispatch('gesturestart', { scale: 1 });
    const change = el.dispatch('gesturechange', { scale: 2 });
    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(host.pinchStart).not.toHaveBeenCalled();
    expect(host.pinchTo).not.toHaveBeenCalled();
  });

  it('zooms a touch dblclick only after two taps that stayed put', () => {
    const press = (id: number, x: number, t: number, dx: number) => {
      pointer('pointerdown', { x, y: 100, t, id, isPrimary: true, ...touch });
      pointer('pointermove', { x: x + dx, y: 100, t: t + 16, id, ...touch });
      pointer('pointerup', { x: x + dx, y: 100, t: t + 20, id, ...touch });
    };
    // Two quick swipes the browser took for a double tap.
    press(1, 100, 0, 60);
    press(2, 110, 100, 60);
    el.dispatch('dblclick', { clientX: 170, clientY: 100 });
    expect(host.zoomAt).not.toHaveBeenCalled();
    // A swipe, then a tap: still not two taps.
    press(3, 100, 1000, 3);
    el.dispatch('dblclick', { clientX: 103, clientY: 100 });
    expect(host.zoomAt).not.toHaveBeenCalled();
    // A second tap makes it a double tap.
    press(4, 101, 1100, 2);
    el.dispatch('dblclick', { clientX: 103, clientY: 100 });
    expect(host.zoomAt).toHaveBeenCalledWith(0.6, 103, 100);
  });

  it('does not count a pinch or a cancelled press as a tap', () => {
    pointer('pointerdown', { x: 100, y: 100, t: 0, id: 1, ...touch });
    pointer('pointerdown', { x: 104, y: 100, t: 10, id: 2, ...touch });
    pointer('pointerup', { x: 100, y: 100, t: 20, id: 1, ...touch });
    pointer('pointerup', { x: 104, y: 100, t: 22, id: 2, ...touch });
    pointer('pointerdown', { x: 100, y: 100, t: 200, id: 3, ...touch });
    pointer('pointercancel', { x: 100, y: 100, t: 220, id: 3, ...touch });
    pointer('pointerdown', { x: 100, y: 100, t: 300, id: 4, ...touch });
    pointer('pointerup', { x: 100, y: 100, t: 320, id: 4, ...touch });
    el.dispatch('dblclick', { clientX: 100, clientY: 100 });
    expect(host.zoomAt).not.toHaveBeenCalled();
  });

  it('removes the touch listeners on dispose', () => {
    const controls = setup();
    controls.dispose();
    for (const type of ['touchstart', 'touchend', 'touchcancel']) {
      expect(el.listeners.get(type)?.size ?? 0).toBe(0);
    }
  });

  it('listens to the touches passively, so scrolling is never held up', () => {
    expect(el.listenerOptions.get('touchstart')).toEqual({ passive: true });
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

/** The vx of the one flick so far, 0 when there was none. */
function flickVx(): number {
  expect(host.flick.mock.calls.length).toBeLessThanOrEqual(1);
  return host.flick.mock.calls[0]?.[0] ?? 0;
}

describe('Controls: release velocity', () => {
  beforeEach(() => {
    setup();
  });

  it('still flings a gentle release that slowed to a stop just before letting go', () => {
    // A mouse button or trackpad click takes a moment to lift after the hand
    // stops; 70 ms is not a deliberate hold.
    const t = drag(5);
    pointer('pointerup', { x: 50, y: 0, t: t + 70 });
    expect(flickVx()).toBeGreaterThan(1);
  });

  it('fades the fling with the rest before release, to none at 100 ms', () => {
    const after = (rest: number) => {
      setup();
      const t = drag(5);
      pointer('pointerup', { x: 50, y: 0, t: t + rest });
      return flickVx();
    };
    const full = after(5);
    expect(after(40)).toBeCloseTo(full, 6);
    expect(after(60)).toBeLessThan(full);
    expect(after(60)).toBeGreaterThan(after(80));
    expect(after(80)).toBeGreaterThan(after(95));
    expect(after(95)).toBeGreaterThan(0);
    expect(after(100)).toBe(0);
    expect(after(150)).toBe(0);
  });

  it('flings when the last drag move already reports the button up', () => {
    // macOS browsers read `buttons` from the live button state, so a drag
    // move handled just after the click lifted says no button is held.
    const t = drag(5);
    pointer('pointermove', { x: 60, y: 0, t: t + 8, buttons: 0 });
    // The drag is over: the move does not pan and the pointerup is ignored.
    pointer('pointerup', { x: 60, y: 0, t: t + 9 });
    expect(host.dragBy).toHaveBeenCalledTimes(5);
    expect(host.flick).toHaveBeenCalledTimes(1);
    expect(flickVx()).toBeGreaterThan(8);
    expect(el.style['cursor']).toBe('grab');
  });

  it('flings when the capture is lost just ahead of the pointerup', () => {
    const t = drag(5);
    pointer('lostpointercapture', { x: 50, y: 0, t: t + 4 });
    pointer('pointerup', { x: 50, y: 0, t: t + 4 });
    expect(host.flick).toHaveBeenCalledTimes(1);
    expect(flickVx()).toBeGreaterThan(8);
  });

  it('flings once when releasing the capture fires lostpointercapture at once', () => {
    el.releasePointerCapture = () => {
      pointer('lostpointercapture', { x: 50, y: 0, t: 85 });
    };
    const t = drag(5);
    pointer('pointerup', { x: 50, y: 0, t: t + 5 });
    expect(host.flick).toHaveBeenCalledTimes(1);
    expect(flickVx()).toBeGreaterThan(8);
  });

  it('never flings on a pointercancel and the lostpointercapture after it', () => {
    const t = drag(5);
    pointer('pointercancel', { x: 50, y: 0, t: t + 5 });
    pointer('lostpointercapture', { x: 50, y: 0, t: t + 5 });
    expect(host.flick).not.toHaveBeenCalled();
  });

  /**
   * A drag with a realistic flick: it speeds up, peaks at 70% of the way and
   * eases to `endFrac` of the peak at release. Hardware samples come at
   * irregular `hw` intervals; Chrome hands them over once per display frame
   * (`coalesceHz`), the last one in each frame, and flushes the rest before
   * the pointerup; Safari sends each. Returns the true release speed in px
   * per 60 Hz frame.
   */
  function flickTrace(o: {
    peak: number; // px per ms
    endFrac: number;
    T: number;
    rest: number;
    hw: [number, number];
    coalesceHz: number | null;
    pointerType?: string;
    seed?: number;
  }): number {
    let seed = o.seed ?? 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const v = (t: number) => {
      const tp = 0.7 * o.T;
      if (t <= tp) return o.peak * Math.sin((Math.PI / 2) * (t / tp));
      return o.peak * (1 - ((1 - o.endFrac) * (t - tp)) / (o.T - tp));
    };
    const pointerType = o.pointerType ?? 'mouse';
    const t0 = 1000;
    pointer('pointerdown', { x: 0, y: 0, t: t0, pointerType });
    let t = 0;
    let x = 0;
    let frameEnd = o.coalesceHz ? rand() * (1000 / o.coalesceHz) : 0;
    let pending: { t: number; x: number } | null = null;
    const send = (s: { t: number; x: number }) =>
      pointer('pointermove', { x: s.x, y: 0, t: t0 + s.t, pointerType });
    while (t < o.T) {
      const next = Math.min(o.T, t + o.hw[0] + rand() * (o.hw[1] - o.hw[0]));
      for (; t < next - 1e-9; t = Math.min(next, t + 0.25)) {
        x += v(t + Math.min(0.25, next - t) / 2) * Math.min(0.25, next - t);
      }
      const s = { t, x };
      if (!o.coalesceHz) send(s);
      else {
        while (s.t > frameEnd) {
          if (pending) send(pending);
          pending = null;
          frameEnd += 1000 / o.coalesceHz;
        }
        pending = s;
      }
    }
    if (pending) send(pending);
    pointer('pointerup', { x, y: 0, t: t0 + o.T + o.rest, pointerType });
    pointer('lostpointercapture', { x, y: 0, t: t0 + o.T + o.rest, pointerType });
    return v(o.T) * (1000 / 60);
  }

  const mouse = { endFrac: 0.85, T: 220, rest: 4, hw: [4, 12] as [number, number] };
  it.each([
    ['a gentle mouse flick at 60 Hz', { ...mouse, peak: 0.5, coalesceHz: 60 }],
    ['a medium mouse flick at 60 Hz', { ...mouse, peak: 1.2, coalesceHz: 60 }],
    ['a gentle mouse flick at 120 Hz', { ...mouse, peak: 0.5, coalesceHz: 120 }],
    ['a medium mouse flick at 120 Hz', { ...mouse, peak: 1.2, coalesceHz: 120 }],
    ['a release 30 ms after the last move', { ...mouse, peak: 1.2, coalesceHz: 60, rest: 30 }],
    ['a gentle Safari flick, uncoalesced', { ...mouse, peak: 0.5, coalesceHz: null, hw: [4, 20] }],
    [
      'a trackpad click-drag that slows before the click lifts',
      { peak: 0.8, endFrac: 0.6, T: 300, rest: 25, hw: [8, 16], coalesceHz: null },
    ],
    [
      'a touch swipe',
      { peak: 1, endFrac: 0.9, T: 160, rest: 6, hw: [4, 20], coalesceHz: 60, pointerType: 'touch' },
    ],
  ] as const)('flings %s at about its release speed', (_name, o) => {
    const trueV = flickTrace({ ...o, hw: [...o.hw] });
    const vx = flickVx();
    expect(vx).toBeGreaterThan(trueV * 0.8);
    expect(vx).toBeLessThan(trueV * 1.4);
  });

  it('does not fling a flick held still for 100 ms before release', () => {
    flickTrace({ ...mouse, peak: 1.2, coalesceHz: 60, hw: [4, 12], rest: 100 });
    expect(flickVx()).toBe(0);
  });
});
