import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FRAME_MS, type CameraRig } from './camera-rig.js';
import { viewProjection, unprojectNDC, effectiveVFovDeg } from './render/projection.js';
import { VIEWER_DEFAULTS } from './defaults.js';
import { dirFromYawPitch } from './test-support/oracles.js';
import { makeRig, frameClock, rigInternals } from './test-support/rig.js';
import { PRE_RIG_CAMERA_TRACE } from './test-support/camera-trace.js';
import type { View } from './types.js';

const { maxHorizontalFov: MAX_H, momentumFriction: FRICTION } = VIEWER_DEFAULTS.camera;

describe('CameraRig', () => {
  describe('compass north offset and heading', () => {
    it('defaults to north=0 and heading tracking the initial yaw', () => {
      const { rig } = makeRig(400, 800, { initialView: { yaw: 0.4 } });
      expect(rig.heading()).toBeCloseTo(-0.4, 10);
    });

    it('setNorth updates the heading immediately', () => {
      const { rig } = makeRig(400, 800, { initialView: { yaw: 0.4 } });
      rig.setNorth(1.2);
      expect(rig.heading()).toBeCloseTo(0.8, 10);
    });
  });

  describe('auto-rotate', () => {
    // The frame clock, in step with the fake timers: advance() is the gap
    // between frames and the time the idle timer sees.
    let now = 0;
    const advance = (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    };

    beforeEach(() => {
      vi.useFakeTimers();
      now = 0;
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A rig and a tick() that steps it one frame at the current time. */
    function rotating(options: Parameters<typeof makeRig>[2]) {
      const { rig, invalidate } = makeRig(400, 800, options);
      const step = frameClock(rig);
      return { rig, invalidate, tick: () => step(now) };
    }

    it('does not rotate when disabled, where the same frames turn an enabled rig', () => {
      const off = rotating({ autoRotate: { speed: 1 }, camera: { damping: 1 } });
      const on = rotating({ autoRotate: { enabled: true, speed: 1 }, camera: { damping: 1 } });
      off.tick(); // timing baseline for both
      on.tick();
      const offBefore = off.rig.view.yaw;
      const onBefore = on.rig.view.yaw;
      advance(50);
      off.tick();
      on.tick();
      expect(on.rig.view.yaw).toBeCloseTo(onBefore + 0.05, 10);
      expect(off.rig.view.yaw).toBeCloseTo(offBefore, 10);
    });

    it('rotates the view forward once real time elapses between frames', () => {
      // damping: 1 snaps view straight to target, so a tick's delta is exactly
      // autoRotateSpeed times the elapsed seconds, with no easing to account for.
      const { rig, tick } = rotating({
        autoRotate: { enabled: true, speed: 1 },
        camera: { damping: 1 },
      });
      tick(); // the first frame only sets the timing baseline
      const before = rig.view.yaw;
      advance(50); // well under the stalled-frame clamp
      tick();
      expect(rig.view.yaw).toBeCloseTo(before + 0.05, 10);
    });

    it('pauses on interaction and resumes only after the idle window elapses', () => {
      const { rig, tick } = rotating({
        autoRotate: { enabled: true, speed: 1, idleMs: 1000 },
        camera: { damping: 1 },
      });
      tick();
      rig.stopMomentum(); // stands in for a real interaction's gesture start
      const paused = rig.view.yaw;

      advance(999);
      tick();
      expect(rig.view.yaw).toBeCloseTo(paused, 10);

      advance(1); // the idle timer fires here, reactivating rotation
      tick(); // first frame back only re-establishes the timing baseline
      expect(rig.view.yaw).toBeCloseTo(paused, 10);

      advance(50);
      tick();
      expect(rig.view.yaw).toBeCloseTo(paused + 0.05, 10);
    });

    it('setAutoRotate(false) cancels a pending resume and stops rotation', () => {
      const { rig, tick } = rotating({
        autoRotate: { enabled: true, speed: 1, idleMs: 1000 },
        camera: { damping: 1 },
      });
      rig.stopMomentum();
      rig.setAutoRotate(false);
      const before = rig.view.yaw;

      advance(1000);
      tick();
      expect(rig.view.yaw).toBeCloseTo(before, 10);
    });

    it('setAutoRotate(true) enables rotation immediately, with no idle wait', () => {
      const { rig, tick } = rotating({
        autoRotate: { speed: 1, idleMs: 5000 }, // idle much longer than the delay used below
        camera: { damping: 1 },
      });
      rig.setAutoRotate(true);
      tick(); // establishes the timing baseline
      const before = rig.view.yaw;

      advance(50); // far short of autoRotateIdleMs
      tick();
      expect(rig.view.yaw).toBeCloseTo(before + 0.05, 10);
    });

    it('does not wrap target.yaw across the ±π seam into a near-2π jump', () => {
      // Regression: normalizing target.yaw used to wrap +π to −π, which
      // damp() then eased view.yaw the long way around — almost a full turn.
      const { rig, tick } = rotating({
        initialView: { yaw: Math.PI - 0.05 },
        autoRotate: { enabled: true, speed: 1 },
        camera: { damping: 1 },
      });
      tick();
      let prev = rig.view.yaw;
      for (let i = 0; i < 5; i++) {
        advance(20); // small, well under the stall clamp
        tick();
        const next = rig.view.yaw;
        expect(next).toBeGreaterThan(prev);
        expect(next - prev).toBeLessThan(0.1);
        prev = next;
      }
      // Keeps climbing past π instead of snapping back down near −π.
      expect(prev).toBeGreaterThan(Math.PI);
    });

    it('keeps target.yaw bounded via whole-turn shifts, without changing the rendered view', () => {
      const start = Math.PI * 1.9; // just under the 2π shift threshold
      const { rig, tick } = rotating({
        initialView: { yaw: start },
        autoRotate: { enabled: true, speed: 5 }, // one clamped 100ms tick crosses the threshold
        camera: { damping: 1 },
      });
      tick();
      advance(200); // clamped to the 100ms stall cap => 0.5 rad
      tick();
      // Shifting target and view by the same whole 2π leaves the rendered
      // angle exactly what an unshifted (start + 0.5) would be, just wrapped.
      expect(rig.view.yaw).toBeCloseTo(start + 0.5 - Math.PI * 2, 10);
      expect(Math.abs(rig.view.yaw)).toBeLessThan(Math.PI * 2);
    });

    it('asks for a frame when the idle window ends, and turns again from then', () => {
      const { rig, invalidate } = rotating({
        autoRotate: { enabled: true, speed: 1, idleMs: 1000 },
      });
      rig.panByPixels(10, 0);
      expect(rig.autoRotating()).toBe(false);
      invalidate.mockClear();
      advance(999);
      expect(invalidate).not.toHaveBeenCalled();
      expect(rig.autoRotating()).toBe(false);
      advance(1);
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(rig.autoRotating()).toBe(true);
    });

    it('restarts the idle window on every interaction', () => {
      const { rig } = rotating({ autoRotate: { enabled: true, speed: 1, idleMs: 1000 } });
      rig.flick(5, 0);
      advance(800);
      rig.stopMomentum();
      advance(800);
      expect(rig.autoRotating()).toBe(false);
      advance(200);
      expect(rig.autoRotating()).toBe(true);
    });

    it('is not paused by programmatic moves', () => {
      const { rig } = rotating({ autoRotate: { enabled: true, speed: 1, idleMs: 1000 } });
      rig.setView({ yaw: 1 });
      rig.zoomBy(0.8);
      rig.cutTo({ pitch: 0.2 });
      expect(rig.autoRotating()).toBe(true);
    });

    it('turns by nothing on the first step after its clock restarts', () => {
      const { rig, tick } = rotating({
        autoRotate: { enabled: true, speed: 1 },
        camera: { damping: 1 },
      });
      tick();
      advance(50);
      rig.restartAutoRotateClock();
      const before = rig.view.yaw;
      tick();
      expect(rig.view.yaw).toBe(before);
      advance(50);
      tick();
      expect(rig.view.yaw).toBeCloseTo(before + 0.05, 10);
    });

    it('does not keep the loop going at zero speed, and stops its timer on dispose', () => {
      const { rig, invalidate } = rotating({ autoRotate: { enabled: true, speed: 0 } });
      expect(rig.autoRotating()).toBe(false);
      rig.setAutoRotate(true);
      rig.stopMomentum();
      rig.dispose();
      invalidate.mockClear();
      advance(10_000);
      expect(invalidate).not.toHaveBeenCalled();
    });
  });

  describe('camera moves', () => {
    it('eases setView the short way round after the yaw has wound up several turns', () => {
      const { rig } = makeRig(400, 800, { initialView: { yaw: 4 * Math.PI + 0.1 } });
      const before = rig.view.yaw;
      rig.setView({ yaw: 0.1 });
      frameClock(rig)(0);
      expect(Math.abs(rig.view.yaw - before)).toBeLessThan(0.1);
      expect(rig.getView().yaw).toBeCloseTo(0.1, 10);
    });

    it('takes the short way across the seam', () => {
      const { rig } = makeRig(400, 800, { initialView: { yaw: Math.PI - 0.1 } });
      rig.setView({ yaw: -Math.PI + 0.1 });
      // 0.2 rad forward across ±π, not 2π − 0.2 back.
      expect(rigInternals(rig).target.yaw).toBeCloseTo(Math.PI + 0.1, 10);
      expect(rig.getView().yaw).toBeCloseTo(-Math.PI + 0.1, 10);
    });

    it('keeps yaw bounded when dragging round and round', () => {
      const { rig } = makeRig(400, 800, { initialView: { yaw: 2 * Math.PI - 0.01 } });
      rig.panByPixels(-100, 0); // drag left → look right, past 2π
      expect(Math.abs(rig.view.yaw)).toBeLessThan(2 * Math.PI);
      expect(rigInternals(rig).target.yaw).toBe(rig.view.yaw);
    });

    it('clamps initialView pitch and fov', () => {
      const { rig } = makeRig(400, 800, {
        initialView: { pitch: 3, fov: 500 },
        camera: { maxFov: 80 },
      });
      const view = rig.getView();
      expect(view.pitch).toBeLessThan(Math.PI / 2);
      expect(view.fov).toBe(80);
      expect(rig.view.pitch).toBe(view.pitch);
      expect(rig.view.fov).toBe(80);
    });

    it('clears momentum on setView', () => {
      const { rig } = makeRig(400, 800);
      rig.flick(100, 50);
      expect(rigInternals(rig).momentum.yaw).not.toBe(0);
      rig.setView({ yaw: 0.5 });
      expect(rigInternals(rig).momentum).toEqual({ yaw: 0, pitch: 0 });
    });

    it('does not settle while momentum is left, however small', () => {
      const { rig } = makeRig(400, 800);
      // rad/ms: a step's travel is under the position settle threshold.
      rigInternals(rig).momentum.yaw = 2e-6;
      expect(rig.step(0, FRAME_MS)).toBe(true);
    });

    it('eases toward the target and settles exactly on it', () => {
      const { rig } = makeRig(400, 800);
      rig.setView({ yaw: 1, pitch: 0.3, fov: 40 });
      // damping 0.25 per 60 Hz frame: a quarter of the way.
      expect(rig.step(0, FRAME_MS)).toBe(true);
      expect(rig.view.yaw).toBeCloseTo(0.25, 12);
      expect(rig.view.fov).toBeCloseTo(70 - 30 * 0.25, 12);
      // Two half frames ease as far as one whole one.
      rig.step(0, FRAME_MS / 2);
      rig.step(0, FRAME_MS / 2);
      expect(rig.view.yaw).toBeCloseTo(1 - 0.75 ** 2, 12);
      let frames = 0;
      while (rig.step(0, FRAME_MS) && frames < 1000) frames++;
      expect(frames).toBeLessThan(100);
      expect(rig.view).toEqual({ yaw: 1, pitch: 0.3, fov: 40 });
    });

    it('cuts only the axes a view sets, and stops a glide either way', () => {
      const { rig } = makeRig(400, 800);
      rig.setView({ pitch: 0.3 });
      rig.flick(30, 0);
      rig.cutTo({ yaw: 1, fov: 50 });
      expect(rig.view).toEqual({ yaw: 1, pitch: 0, fov: 50 });
      expect(rig.getView()).toEqual({ yaw: 1, pitch: 0.3, fov: 50 });
      expect(rigInternals(rig).momentum).toEqual({ yaw: 0, pitch: 0 });
      rig.flick(30, 0);
      rig.cutTo();
      expect(rigInternals(rig).momentum).toEqual({ yaw: 0, pitch: 0 });
      expect(rig.view).toEqual({ yaw: 1, pitch: 0, fov: 50 });
    });

    it('moves only the target on a key pan, for damping to ease after', () => {
      const { rig, invalidate } = makeRig(400, 800);
      rig.panTargetByPixels(40, -20);
      expect(rig.view).toEqual({ yaw: 0, pitch: 0, fov: 70 });
      const { target } = rigInternals(rig);
      expect(target.yaw).toBeLessThan(0); // right → look left
      expect(target.pitch).toBeLessThan(0);
      expect(invalidate).toHaveBeenCalled();
    });

    it('drags by the angle each pixel covers at the drawn fov', () => {
      const { rig } = makeRig(400, 800);
      rig.panByPixels(-4, 0);
      const vfov = (effectiveVFovDeg(70, MAX_H, 0.5) * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * 0.5);
      expect(rig.view.yaw).toBeCloseTo(4 * (2 * Math.tan(hfov / 2)) * (1 / 400), 3);
    });

    it('reports the target with its yaw in (−π, π]', () => {
      const { rig } = makeRig(400, 800, { initialView: { yaw: 3 * Math.PI + 0.5 } });
      expect(rig.getView().yaw).toBeCloseTo(-Math.PI + 0.5, 10);
    });

    it('gives the view a scene arrives with: the target with its axes applied', () => {
      const { rig } = makeRig(400, 800);
      rig.setView({ yaw: 0.5, pitch: 0.2 });
      expect(rig.arrival(undefined)).toEqual({ yaw: 0.5, pitch: 0.2, fov: 70 });
      expect(rig.arrival({ fov: 500, pitch: 9 })).toEqual({
        yaw: 0.5,
        pitch: VIEWER_DEFAULTS.camera.maxPitch,
        fov: 80,
      });
    });

    it('keeps the last real aspect through a zero-size viewport', () => {
      const { rig } = makeRig(1600, 900);
      rig.setViewport(800, 0);
      expect(rig.aspect).toBe(1600 / 900);
      expect(rig.cssW).toBe(800);
      expect(rig.cssH).toBe(1);
    });
  });

  describe('momentum', () => {
    /** Where the target has glided `ms` after a flick, stepping at `hz`. */
    function glide(hz: number, ms: number): { yaw: number; rig: CameraRig } {
      const { rig } = makeRig(400, 800);
      rig.flick(30, 0);
      const m = rigInternals(rig).momentum.yaw;
      for (let t = 0; t < ms - 1e-6; t += 1000 / hz) rig.step(t, 1000 / hz);
      return { yaw: rigInternals(rig).target.yaw / m, rig };
    }

    it('decays exponentially, travelling the integral of the decay', () => {
      // Per 60 Hz frame the momentum keeps FRICTION of itself, so after n
      // frames the target has moved m · FRAME_MS · (1 − FRICTION^n) / (1 − FRICTION).
      for (const n of [1, 2, 5, 12]) {
        const { yaw } = glide(60, n * FRAME_MS);
        expect(yaw).toBeCloseTo((FRAME_MS * (1 - FRICTION ** n)) / (1 - FRICTION), 9);
      }
    });

    it('glides the same distance at the same pace at 30, 60 and 120 Hz', () => {
      const at60 = glide(60, 200).yaw;
      expect(glide(30, 200).yaw).toBeCloseTo(at60, 9);
      expect(glide(120, 200).yaw).toBeCloseTo(at60, 9);
    });

    it('stops once it falls below the cut-off, and the camera then settles', () => {
      const { rig } = makeRig(400, 800);
      rig.flick(30, 10);
      let frames = 0;
      while (rig.step(frames * FRAME_MS, FRAME_MS) && frames < 2000) frames++;
      expect(frames).toBeLessThan(2000);
      expect(rigInternals(rig).momentum).toEqual({ yaw: 0, pitch: 0 });
      expect(rig.view).toEqual({ ...rigInternals(rig).target });
    });

    it('carries pitch within its limits', () => {
      const { rig } = makeRig(400, 800, { initialView: { pitch: 1.5 } });
      rig.flick(0, 200);
      for (let i = 0; i < 60; i++) rig.step(i * FRAME_MS, FRAME_MS);
      expect(rigInternals(rig).target.pitch).toBe(VIEWER_DEFAULTS.camera.maxPitch);
    });

    it('is stopped by a zoom or a pinch', () => {
      const { rig } = makeRig(1200, 800);
      rig.flick(30, 0);
      rig.zoomAt(0.9, 600, 400);
      expect(rigInternals(rig).momentum).toEqual({ yaw: 0, pitch: 0 });
      rig.flick(30, 0);
      rig.pinchStart(600, 400);
      expect(rigInternals(rig).momentum).toEqual({ yaw: 0, pitch: 0 });
    });
  });

  describe('drags', () => {
    // Yaw per pixel of drag at the default fov in a 400 × 800 rig.
    const yawPerPx = (() => {
      const { rig } = makeRig(400, 800);
      rig.panByPixels(-1, 0);
      return rig.view.yaw;
    })();
    /** How far right the rig has been dragged, px. */
    const draggedPx = (rig: CameraRig) => -rig.view.yaw / yawPerPx;

    /** A rig dragged right at 0.5 px/ms, a move every 10 ms, for `ms`; frames at 60 Hz. */
    function dragRig(ms: number) {
      const made = makeRig(400, 800);
      const { rig } = made;
      const frame = frameClock(rig);
      rig.dragStart(0);
      let t = FRAME_MS;
      for (let m = 10; m <= ms; m += 10) {
        for (; t < m; t += FRAME_MS) frame(t);
        rig.dragBy(5, 0, m);
      }
      return { ...made, frame, t };
    }

    it('moves the camera on frames, not moves, a little behind the pointer', () => {
      const { rig, invalidate, frame, t } = dragRig(300);
      expect(invalidate).toHaveBeenCalled();
      const before = draggedPx(rig);
      rig.dragBy(5, 0, 305);
      expect(draggedPx(rig)).toBe(before);
      frame(t);
      // The pointer is at 0.5 px/ms · t; the camera trails it by one input
      // period and the filter's smoothing: some ms, not tens.
      const lagMs = (0.5 * t - draggedPx(rig)) / 0.5;
      expect(lagMs).toBeGreaterThan(5);
      expect(lagMs).toBeLessThan(25);
    });

    it('catches up with a pointer that holds still, then settles', () => {
      const { rig, frame } = dragRig(300);
      let t = 300;
      let frames = 0;
      while (frame((t += FRAME_MS)) && frames < 200) frames++;
      expect(frames).toBeLessThan(200);
      expect(draggedPx(rig)).toBeCloseTo(150, 1);
    });

    it('puts what it had yet to draw on the target when it ends', () => {
      const { rig, frame } = dragRig(300);
      rig.dragEnd();
      expect(draggedPx(rig)).toBeLessThan(150);
      expect(-rigInternals(rig).target.yaw / yawPerPx).toBeCloseTo(150, 6);
      let t = 300;
      while (frame((t += FRAME_MS)) && t < 5000);
      expect(draggedPx(rig)).toBeCloseTo(150, 6);
    });

    it('hands what it had yet to draw to a flick, which glides it in', () => {
      const { rig, frame, t: next } = dragRig(300);
      const shown = draggedPx(rig);
      rig.dragEnd();
      rig.flick(0, 0);
      const { target, momentum } = rigInternals(rig);
      expect(target.yaw).toBe(rig.view.yaw);
      expect(momentum.yaw).toBeLessThan(0);
      // The first glide frame covers a tenth of what was left (1 − friction).
      let t = next;
      frame(t);
      expect(draggedPx(rig) - shown).toBeCloseTo((150 - shown) * (1 - FRICTION), 6);
      while (frame((t += FRAME_MS)) && t < 5000);
      expect(draggedPx(rig)).toBeCloseTo(150, 0);
    });

    it('lines up moves stamped on a clock far from the frame clock', () => {
      const { rig } = makeRig(400, 800);
      const frame = frameClock(rig);
      rig.dragStart(1e6);
      for (let i = 1; i <= 30; i++) {
        rig.dragBy(5, 0, 1e6 + i * 10);
        frame(i * 10);
      }
      expect(draggedPx(rig)).toBeGreaterThan(100);
      expect(draggedPx(rig)).toBeLessThan(150);
    });

    it('flings what was left of a drag released next to the ±2π wrap, not a whole turn', () => {
      const release = (yaw: number) => {
        const { rig } = makeRig(400, 800, { initialView: { yaw } });
        const frame = frameClock(rig);
        rig.dragStart(0);
        let t = FRAME_MS;
        for (let m = 10; m <= 100; m += 10) {
          for (; t < m; t += FRAME_MS) frame(t);
          rig.dragBy(5, 0, m);
        }
        const drawn = rig.view.yaw - yaw;
        rig.dragEnd();
        rig.flick(-2, 0);
        const start = rig.view.yaw;
        while (frame((t += FRAME_MS)) && t < 10_000);
        return { drawn, glide: rig.view.yaw - start };
      };
      const ref = release(0);
      // The rest of the drag carries the target across −2π, where it is
      // wound back by a whole turn.
      const nearWrap = release(-2 * Math.PI + 0.001 - ref.drawn);
      expect(nearWrap.glide).toBeCloseTo(ref.glide, 9);
    });

    /** Drag at 0.5 px/ms from `start` for 500 ms; the mean lag over its last 300 ms. */
    function lagAfter(rig: CameraRig, frame: (t: number) => boolean, start: number): number {
      let t = Math.ceil(start / FRAME_MS) * FRAME_MS;
      const lags: number[] = [];
      for (let m = start; m <= start + 500; m += 10) {
        for (; t < m; t += FRAME_MS) {
          frame(t);
          if (t > start + 200) lags.push((0.5 * (t - start) - draggedPx(rig)) / 0.5);
        }
        rig.dragBy(5, 0, m);
      }
      return lags.reduce((a, b) => a + b, 0) / lags.length;
    }

    it('keeps up with a drag that sets off after a long hold, whatever frames came in it', () => {
      const lag = (strayFrameAt?: number) => {
        const { rig } = makeRig(400, 800);
        const frame = frameClock(rig);
        rig.dragStart(0);
        // A frame drawn while the pointer is held still: a tile, a timer.
        if (strayFrameAt !== undefined) frame(strayFrameAt);
        return lagAfter(rig, frame, 3010);
      };
      const none = lag();
      expect(none).toBeLessThan(25);
      for (const at of [900, 1200, 3000]) expect(Math.abs(lag(at) - none)).toBeLessThan(1);
    });

    it('keeps up after a jank of over a second between the press and the next frame', () => {
      const { rig } = makeRig(400, 800);
      const frame = frameClock(rig);
      frame(0);
      rig.dragStart(20);
      frame(1130);
      expect(lagAfter(rig, frame, 1140)).toBeLessThan(25);
    });

    it('starts afresh, with nothing left over, after a pinch takes over', () => {
      const { rig } = dragRig(300);
      rig.dragEnd();
      rig.pinchStart(200, 400);
      rig.pinchTo(1, 200, 400);
      rig.flick(0, 0);
      expect(rigInternals(rig).momentum).toEqual({ yaw: 0, pitch: 0 });
    });
  });

  describe('pinned numbers', () => {
    // Exact outputs of PanoViewer's camera before the CameraRig existed, for
    // fixed inputs, compared bit for bit: a change to the order of the float
    // operations in the zoom anchor, the pinch solve, momentum or damping
    // shows up here first. (The glide has since moved the view as well as
    // the target; see camera-trace.ts.)
    it('zooms, pinches, glides and eases to the same bits as before the extraction', () => {
      const { rig } = makeRig(1200, 800, { initialView: { yaw: 0.3, pitch: 0.4, fov: 72 } });
      const { target, momentum } = rigInternals(rig);
      const out: number[] = [];
      const rec = () => {
        out.push(rig.view.yaw, rig.view.pitch, rig.view.fov, target.yaw, target.pitch, target.fov);
      };
      for (let k = 0; k < 12; k++) {
        rig.zoomAt(k % 3 === 2 ? 1.17 : 0.83, 97 + k * 91, 53 + ((k * 137) % 700));
        rec();
      }
      rig.pinchStart(700, 300);
      for (let k = 1; k <= 8; k++) {
        rig.pinchTo(1 - k * 0.061, 700 + k * 13, 300 + k * 7);
        rec();
      }
      rig.flick(30, -8);
      const frame = frameClock(rig);
      let t = 0;
      for (let k = 0; k < 20; k++) {
        t += [7, 16.7, 3, 41, 9][k % 5]!;
        frame(t);
        rec();
        out.push(momentum.yaw, momentum.pitch);
      }
      rig.panTargetByPixels(40, -25);
      rig.setView({ fov: 30 });
      for (let k = 0; k < 10; k++) {
        t += [8, 16.7, 33][k % 3]!;
        frame(t);
        rec();
      }
      expect(out).toEqual(PRE_RIG_CAMERA_TRACE);
    });
  });

  describe('zoom and pinch anchors', () => {
    const W = 1200;
    const H = 800;
    // The oracle projects through a Float32 matrix.
    const TOL = 1e-6;

    /** The scene direction at pixel (x, y) of a W × H viewport, as the camera is drawn. */
    function directionAt(rig: CameraRig, x: number, y: number): { yaw: number; pitch: number } {
      const vp = viewProjection(rig.view, rig.aspect, MAX_H);
      const v = unprojectNDC((x / W) * 2 - 1, -((y / H) * 2 - 1), vp);
      return { yaw: Math.atan2(v.x, -v.z), pitch: Math.asin(Math.max(-1, Math.min(1, v.y))) };
    }

    function angleBetween(a: { yaw: number; pitch: number }, b: { yaw: number; pitch: number }) {
      const u = dirFromYawPitch(a.yaw, a.pitch);
      const v = dirFromYawPitch(b.yaw, b.pitch);
      return Math.acos(Math.min(1, Math.max(-1, u.x * v.x + u.y * v.y + u.z * v.z)));
    }

    function settled(view: View): CameraRig {
      const { rig } = makeRig(W, H);
      rig.cutTo(view);
      return rig;
    }

    it.each([
      { name: 'zoom in, level', x: 1050, y: 120, pitch: 0, fov: 70, scale: 0.8 },
      { name: 'zoom in, pitched up', x: 1050, y: 120, pitch: 0.6, fov: 70, scale: 0.8 },
      { name: 'zoom in, pitched down', x: 150, y: 700, pitch: -0.5, fov: 70, scale: 0.7 },
      { name: 'zoom out, pitched up', x: 1000, y: 650, pitch: 0.4, fov: 20, scale: 1.25 },
      {
        name: 'zoom in from the horizontal fov cap',
        x: 1150,
        y: 60,
        pitch: 0.3,
        fov: 80,
        scale: 0.8,
      },
    ])('keeps the scene under the pointer through zoomAt: $name', ({ x, y, pitch, fov, scale }) => {
      const rig = settled({ yaw: 0.3, pitch, fov });
      const anchor = directionAt(rig, x, y);
      for (let i = 0; i < 4; i++) {
        rig.zoomAt(scale, x, y);
        expect(angleBetween(directionAt(rig, x, y), anchor)).toBeLessThan(TOL);
      }
      expect(rig.view.fov).not.toBeCloseTo(fov, 1);
      // A zoom step is applied at once: view and target agree.
      expect(rigInternals(rig).target).toEqual({ ...rig.view });
    });

    it('steps the zoom from the drawn fov, not one above the cap', () => {
      const rig = settled({ yaw: 0, pitch: 0, fov: 80 });
      const cap = effectiveVFovDeg(80, MAX_H, W / H);
      rig.zoomAt(0.8, W / 2, H / 2);
      expect(rig.view.fov).toBeCloseTo(cap * 0.8, 9);
    });

    it('keeps the pinch start direction under a moving midpoint', () => {
      const rig = settled({ yaw: 0.2, pitch: 0.4, fov: 75 });
      const start = { x: 750, y: 310 };
      const anchor = directionAt(rig, start.x, start.y);
      rig.pinchStart(start.x, start.y);
      for (let i = 1; i <= 20; i++) {
        const x = start.x + i * 4;
        const y = start.y + i * 3;
        rig.pinchTo(1 - i * 0.025, x, y);
        expect(angleBetween(directionAt(rig, x, y), anchor)).toBeLessThan(TOL);
      }
      expect(rig.view.fov).toBeCloseTo(75 * 0.5, 9);
    });

    it('solves each pinch step from the start, so a step back undoes it exactly', () => {
      const rig = settled({ yaw: -0.4, pitch: -0.2, fov: 60 });
      rig.pinchStart(300, 500);
      rig.pinchTo(1, 300, 500);
      const before = { ...rig.view };
      rig.pinchTo(0.6, 420, 380);
      rig.pinchTo(1, 300, 500);
      expect(rig.view.yaw).toBeCloseTo(before.yaw, 12);
      expect(rig.view.pitch).toBeCloseTo(before.pitch, 12);
      expect(rig.view.fov).toBe(before.fov);
    });

    it('keeps a zoom at the pitch limit instead of turning the camera round', () => {
      const rig = settled({ yaw: 0, pitch: 1.45, fov: 80 });
      for (let i = 0; i < 20; i++) {
        rig.zoomAt(0.8, 650, 40);
        expect(rig.view.pitch).toBeLessThanOrEqual(VIEWER_DEFAULTS.camera.maxPitch);
        expect(Math.abs(rig.view.yaw)).toBeLessThan(Math.PI / 2);
      }
    });
  });
});
