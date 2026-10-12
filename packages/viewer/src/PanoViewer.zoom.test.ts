import { describe, it, expect, vi } from 'vitest';
import { PINCH_ARM_MS } from './controls.js';
import { effectiveVFovDeg } from './render/projection.js';
import type { View } from './types.js';
import { dirFromYawPitch } from './test-support/oracles.js';
import {
  useViewerGlobals,
  raf,
  TestViewer,
  internals,
  runUntilIdle,
  canvasListener,
  makeContainer,
} from './test-support/viewer-harness.js';

vi.mock('./render/gl-renderer.js', () => import('./test-support/fake-gl-renderer.js'));

describe('PanoViewer', () => {
  useViewerGlobals();

  describe('zoom', () => {
    it('zooms about the pointer through the canvas rect, CSS transforms included', () => {
      const viewer = new TestViewer(makeContainer(400, 800));
      runUntilIdle();
      // Scaled 2x by a CSS transform: the layout size is 400x800, the rect 800x1600.
      const canvas = internals(viewer).renderer.canvas as unknown as {
        getBoundingClientRect: () => DOMRect;
      };
      canvas.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 800, height: 1600 }) as DOMRect;
      canvasListener(
        viewer,
        'wheel',
      )({
        deltaY: -100,
        deltaX: 0,
        deltaMode: 0,
        ctrlKey: false,
        metaKey: false,
        clientX: 400, // the centre of the rect
        clientY: 800,
        preventDefault: vi.fn(),
      });
      const { target } = internals(viewer).rig;
      expect(target.fov).toBeLessThan(70);
      expect(target.yaw).toBeCloseTo(0, 10);
      expect(target.pitch).toBeCloseTo(0, 10);
      viewer.dispose();
    });

    describe('zoom to the cursor', () => {
      // The scene direction under the cursor when a zoom starts must stay
      // under it, frame after frame, until the zoom settles; off the screen's
      // centre lines and with the camera pitched too, not only on the axes.
      const W = 1200;
      const H = 800;
      const TOL = 1e-6;

      /** Angle (rad) between two view directions. */
      function angleBetween(
        a: { yaw: number; pitch: number },
        b: { yaw: number; pitch: number },
      ): number {
        const u = dirFromYawPitch(a.yaw, a.pitch);
        const v = dirFromYawPitch(b.yaw, b.pitch);
        const dot = u.x * v.x + u.y * v.y + u.z * v.z;
        return Math.acos(Math.min(1, Math.max(-1, dot)));
      }

      function zoomViewer(view: View): TestViewer {
        const viewer = new TestViewer(makeContainer(W, H));
        const canvas = internals(viewer).renderer.canvas as unknown as {
          getBoundingClientRect: () => DOMRect;
        };
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H }) as DOMRect;
        viewer.setView(view);
        runUntilIdle();
        return viewer;
      }

      const wheelAt = (viewer: TestViewer, x: number, y: number, deltaY: number, deltaX = 0) =>
        canvasListener(
          viewer,
          'wheel',
        )({
          deltaY,
          deltaX,
          deltaMode: 0,
          ctrlKey: false,
          metaKey: false,
          clientX: x,
          clientY: y,
          timeStamp: raf.now,
          preventDefault: vi.fn(),
        });

      /** Step frames `ms` apart until the camera settles, checking the cursor every frame. */
      function settleKeepingAnchor(
        viewer: TestViewer,
        x: number,
        y: number,
        anchor: { yaw: number; pitch: number },
        ms: number,
      ): number {
        let worst = 0;
        let frames = 0;
        while (raf.pending > 0 && frames < 2000) {
          raf.step(raf.now + ms);
          frames++;
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(x, y), anchor));
        }
        return worst;
      }

      it.each([
        {
          name: 'zoom in, level, 16 ms frames',
          x: 1050,
          y: 120,
          pitch: 0,
          fov: 70,
          dy: -100,
          ms: 16,
        },
        {
          name: 'zoom in, pitched up, 16 ms frames',
          x: 1050,
          y: 120,
          pitch: 0.6,
          fov: 70,
          dy: -100,
          ms: 16,
        },
        {
          name: 'zoom in, pitched down, 8 ms frames',
          x: 150,
          y: 700,
          pitch: -0.5,
          fov: 70,
          dy: -100,
          ms: 8,
        },
        {
          name: 'zoom out, pitched up, 16 ms frames',
          x: 1000,
          y: 650,
          pitch: 0.4,
          fov: 20,
          dy: 100,
          ms: 16,
        },
        {
          name: 'zoom out, pitched down, 8 ms frames',
          x: 200,
          y: 100,
          pitch: -0.4,
          fov: 20,
          dy: 100,
          ms: 8,
        },
        {
          name: 'zoom in from the horizontal fov cap',
          x: 1150,
          y: 60,
          pitch: 0.3,
          fov: 80,
          dy: -100,
          ms: 16,
        },
      ])('keeps the wheel anchor under the cursor: $name', ({ x, y, pitch, fov, dy, ms }) => {
        const viewer = zoomViewer({ yaw: 0.3, pitch, fov });
        const anchor = viewer.directionAtPixel(x, y);
        let worst = 0;
        // A burst: several wheel events a frame, then frames between bursts.
        for (let burst = 0; burst < 8; burst++) {
          for (let i = 0; i < 3; i++) wheelAt(viewer, x, y, dy);
          raf.step(raf.now + ms);
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(x, y), anchor));
        }
        worst = Math.max(worst, settleKeepingAnchor(viewer, x, y, anchor, ms));
        expect(internals(viewer).rig.view.fov).not.toBeCloseTo(fov, 1);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('keeps the anchor through a scroll-zoom that jitters sideways', () => {
        const viewer = zoomViewer({ yaw: 0.3, pitch: 0.3, fov: 75 });
        const x = 980;
        const y = 180;
        const anchor = viewer.directionAtPixel(x, y);
        let worst = 0;
        // A two-finger scroll is never exactly vertical, and its momentum
        // tail keeps sending small deltaX values.
        const jitter = [0.5, -0.4, 1.2, -0.8, 3, 0.2, -2.5, 0.7];
        for (let i = 0; i < 30; i++) {
          wheelAt(viewer, x, y, -8, jitter[i % jitter.length]!);
          raf.step(raf.now + 16);
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(x, y), anchor));
        }
        worst = Math.max(worst, settleKeepingAnchor(viewer, x, y, anchor, 16));
        expect(internals(viewer).rig.view.fov).toBeLessThan(60);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('pans on a mostly sideways swipe without zooming', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0, fov: 70 });
        wheelAt(viewer, 600, 400, 4, 40);
        runUntilIdle();
        expect(internals(viewer).rig.view.fov).toBe(70);
        expect(internals(viewer).rig.view.yaw).toBeGreaterThan(0); // a deltaX right turns right
        viewer.dispose();
      });

      it('stops a fling glide when a zoom starts, so the anchor holds', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0.3, fov: 70 });
        internals(viewer).rig.flick(25, 5);
        raf.step(raf.now + 16);
        const x = 1000;
        const y = 200;
        const anchor = viewer.directionAtPixel(x, y);
        for (let i = 0; i < 4; i++) wheelAt(viewer, x, y, -100);
        expect(internals(viewer).rig.momentum).toEqual({ yaw: 0, pitch: 0 });
        expect(settleKeepingAnchor(viewer, x, y, anchor, 16)).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('anchors on the fov on screen when a wheel zoom lands mid fov glide', () => {
        const viewer = zoomViewer({ yaw: 0.2, pitch: 0.4, fov: 75 });
        viewer.setView({ fov: 30 }); // a button zoom: the fov eases toward 30
        raf.step(raf.now + 16);
        raf.step(raf.now + 16);
        const { view, target } = internals(viewer).rig;
        expect(view.fov).not.toBeCloseTo(target.fov, 1);
        const x = 200;
        const y = 650;
        const anchor = viewer.directionAtPixel(x, y);
        wheelAt(viewer, x, y, -100);
        expect(settleKeepingAnchor(viewer, x, y, anchor, 8)).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('re-anchors on the new cursor position when the cursor moves', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0.5, fov: 75 });
        for (let i = 0; i < 4; i++) wheelAt(viewer, 1000, 150, -100);
        settleKeepingAnchor(viewer, 1000, 150, viewer.directionAtPixel(1000, 150), 16);
        const moved = viewer.directionAtPixel(250, 600);
        for (let i = 0; i < 4; i++) {
          wheelAt(viewer, 250, 600, -100);
          raf.step(raf.now + 16);
          expect(angleBetween(viewer.directionAtPixel(250, 600), moved)).toBeLessThan(TOL);
        }
        expect(settleKeepingAnchor(viewer, 250, 600, moved, 16)).toBeLessThan(TOL);
        viewer.dispose();
      });

      /** Two touch pointers on the viewer's canvas, moved one event at a time. */
      function fingers(viewer: TestViewer, a: [number, number], b: [number, number]) {
        const pos = { 1: a, 2: b };
        const send = (type: string, id: 1 | 2) =>
          canvasListener(
            viewer,
            type,
          )({
            pointerId: id,
            pointerType: 'touch',
            button: 0,
            clientX: pos[id][0],
            clientY: pos[id][1],
            timeStamp: raf.now,
          });
        send('pointerdown', 1);
        send('pointerdown', 2);
        // Both fingers down a moment: the pinch starts with their next move.
        raf.step(raf.now + PINCH_ARM_MS);
        return {
          mid: (): [number, number] => [(pos[1][0] + pos[2][0]) / 2, (pos[1][1] + pos[2][1]) / 2],
          move(id: 1 | 2, x: number, y: number) {
            pos[id] = [x, y];
            send('pointermove', id);
          },
          lift(id: 1 | 2) {
            send('pointerup', id);
          },
          at: (id: 1 | 2) => pos[id],
        };
      }

      /**
       * A pinch whose fingers move one event at a time, unevenly, while their
       * midpoint also travels. After every event the scene direction that was
       * under the midpoint at the start must be under the midpoint now.
       */
      function pinchTracking(
        viewer: TestViewer,
        start: [[number, number], [number, number]],
        steps: number,
        spread: number,
        travel: [number, number],
      ): number {
        const f = fingers(viewer, start[0], start[1]);
        const [mx, my] = f.mid();
        const anchor = viewer.directionAtPixel(mx, my);
        let worst = 0;
        for (let i = 0; i < steps; i++) {
          // Finger 1 moves out by more than finger 2, and each takes its turn.
          const [x1, y1] = f.at(1);
          f.move(1, x1 - spread * 1.6 + travel[0], y1 + travel[1] - spread * 0.3);
          raf.step(raf.now + 8);
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(...f.mid()), anchor));
          const [x2, y2] = f.at(2);
          f.move(2, x2 + spread * 0.4 + travel[0], y2 + travel[1] + spread * 0.2);
          raf.step(raf.now + 8);
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(...f.mid()), anchor));
        }
        return Math.max(worst, settleKeepingAnchor(viewer, ...f.mid(), anchor, 8));
      }

      it('keeps the pinch start direction under the moving midpoint', () => {
        const viewer = zoomViewer({ yaw: 0.2, pitch: 0.4, fov: 75 });
        const worst = pinchTracking(
          viewer,
          [
            [700, 300],
            [800, 320],
          ],
          20,
          6,
          [4, 3],
        );
        expect(internals(viewer).rig.view.fov).toBeLessThan(40);
        expect(internals(viewer).rig.view.fov).toBeGreaterThan(15);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('keeps tracking the midpoint once the pinch hits the fov limit', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: -0.2, fov: 40 });
        const worst = pinchTracking(
          viewer,
          [
            [500, 500],
            [560, 500],
          ],
          30,
          12,
          [-3, -4],
        );
        expect(internals(viewer).rig.view.fov).toBe(15);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('keeps tracking the midpoint through a pinch near the zenith', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 1.2, fov: 70 });
        // The midpoint's direction is past straight up when the pinch starts.
        const worst = pinchTracking(
          viewer,
          [
            [560, 150],
            [640, 150],
          ],
          12,
          4,
          [2, 1],
        );
        expect(internals(viewer).rig.view.fov).toBeLessThan(50);
        // Exact, and by pitching on over the top, not by turning around.
        expect(Math.abs(internals(viewer).rig.view.yaw)).toBeLessThan(0.5);
        expect(internals(viewer).rig.view.pitch).toBeGreaterThan(1.2);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('zooms out on a pinch in, tracking the midpoint', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0.3, fov: 30 });
        const worst = pinchTracking(
          viewer,
          [
            [300, 200],
            [700, 300],
          ],
          15,
          -6,
          [5, 2],
        );
        expect(internals(viewer).rig.view.fov).toBeGreaterThan(40);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('hands a pinch to a drag without a jump when a finger lifts', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0.3, fov: 70 });
        const f = fingers(viewer, [700, 300], [800, 300]);
        f.move(2, 900, 310);
        f.move(1, 650, 300);
        runUntilIdle();
        const before = { ...internals(viewer).rig.view };
        f.lift(1);
        runUntilIdle();
        expect(internals(viewer).rig.view).toEqual(before);
        // The finger left drags by what it moves, not by where the midpoint was.
        f.move(2, 902, 310);
        runUntilIdle();
        const { view } = internals(viewer).rig;
        expect(view.fov).toBe(before.fov);
        expect(Math.abs(view.yaw - before.yaw)).toBeGreaterThan(0);
        expect(Math.abs(view.yaw - before.yaw)).toBeLessThan(0.01);
        expect(view.pitch).toBeCloseTo(before.pitch, 12);
        viewer.dispose();
      });

      /**
       * Whether a pitch inside the limits shows the direction `dir` exactly
       * at NDC (nx, ny) at `fov` without crossing to the other side of the
       * pole from `was` (its angle above the horizon in the camera's vertical
       * plane now). Scans for a root of the height match.
       */
      function exactOnSideExists(
        dir: { pitch: number },
        nx: number,
        ny: number,
        fov: number,
        was: number,
      ): boolean {
        const limit = Math.PI / 2 - 0.001;
        const ty = Math.tan((effectiveVFovDeg(fov, 100, W / H) * Math.PI) / 360);
        const cx = nx * ty * (W / H);
        const cy = ny * ty;
        const r = Math.sqrt(cy * cy + 1) / Math.sqrt(cx * cx + cy * cy + 1);
        const up = Math.atan(cy);
        const side = (p: number) => (p + up > Math.PI / 2 ? 1 : p + up < -Math.PI / 2 ? 2 : 0);
        const want = was > Math.PI / 2 ? 1 : was < -Math.PI / 2 ? 2 : 0;
        const f = (p: number) => r * Math.sin(p + up) - Math.sin(dir.pitch);
        for (let i = 0; i < 4000; i++) {
          const a = -limit + (2 * limit * i) / 4000;
          const b = -limit + (2 * limit * (i + 1)) / 4000;
          if (f(a) * f(b) < 0 && side(a) === want && side(b) === want) return true;
        }
        return false;
      }

      /** The angle above the horizon, in the camera's vertical plane, of the point at NDC y. */
      const wasAt = (viewer: TestViewer, ny: number) => {
        const { view } = internals(viewer).rig;
        const ty = Math.tan((effectiveVFovDeg(view.fov, 100, W / H) * Math.PI) / 360);
        return view.pitch + Math.atan(ny * ty);
      };

      const nearPole: [number, number, number][] = [];
      for (const pitch of [1.28, 1.36, 1.48, -1.28, -1.36, -1.48]) {
        for (const x of [60, 360, 960])
          for (const y of [8, 40, 760, 792]) nearPole.push([pitch, x, y]);
      }

      it.each([
        {
          name: 'a wheel notch',
          fire: (v: TestViewer, x: number, y: number) => wheelAt(v, x, y, -100),
        },
        {
          name: 'a capped wheel event',
          fire: (v: TestViewer, x: number, y: number) => wheelAt(v, x, y, -300),
        },
        {
          name: 'a double-click',
          fire: (v: TestViewer, x: number, y: number) =>
            canvasListener(v, 'dblclick')({ clientX: x, clientY: y, preventDefault: vi.fn() }),
        },
      ])('keeps the anchor exact near the poles for $name whenever it can', ({ fire }) => {
        let exact = 0;
        for (const [pitch, x, y] of nearPole) {
          const viewer = zoomViewer({ yaw: 0, pitch, fov: 78 });
          const nx = (x / W) * 2 - 1;
          const ny = -((y / H) * 2 - 1);
          const anchor = viewer.directionAtPixel(x, y);
          const was = wasAt(viewer, ny);
          fire(viewer, x, y);
          runUntilIdle();
          const { view } = internals(viewer).rig;
          const drift = angleBetween(viewer.directionAtPixel(x, y), anchor);
          const at = `pitch ${pitch} at (${x}, ${y})`;
          if (exactOnSideExists(anchor, nx, ny, view.fov, was)) {
            exact++;
            expect(drift, at).toBeLessThan(TOL);
          } else {
            // Held at the limit: the point eases off, the camera never turns round.
            expect(Math.abs(view.pitch), at).toBeCloseTo(Math.PI / 2 - 0.001, 9);
          }
          expect(Math.abs(view.yaw), at).toBeLessThan(Math.PI / 2);
          viewer.dispose();
        }
        expect(exact).toBeGreaterThanOrEqual(nearPole.length / 2);
      });

      it('keeps a pinch exact toward the pitch limit, then eases off without a jump', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 1.3, fov: 70 });
        const f = fingers(viewer, [560, 300], [640, 300]);
        const anchor = viewer.directionAtPixel(...f.mid());
        let exactSteps = 0;
        let heldSteps = 0;
        let prev = { ...internals(viewer).rig.view };
        // Drag the midpoint down while spreading: the camera has to pitch up
        // to keep the start direction under it, until the limit holds it.
        for (let i = 0; i < 40; i++) {
          const id = i % 2 ? 2 : 1;
          const [x, y] = f.at(id);
          const [, my] = f.mid();
          const was = wasAt(viewer, -((my / H) * 2 - 1));
          f.move(id, x + (id === 1 ? -1 : 1), y + 24);
          raf.step(raf.now + 8);
          const [mx2, my2] = f.mid();
          const { view } = internals(viewer).rig;
          const nx = (mx2 / W) * 2 - 1;
          const ny = -((my2 / H) * 2 - 1);
          if (exactOnSideExists(anchor, nx, ny, view.fov, was)) {
            exactSteps++;
            expect(angleBetween(viewer.directionAtPixel(mx2, my2), anchor)).toBeLessThan(TOL);
          } else {
            heldSteps++;
            expect(view.pitch).toBeCloseTo(Math.PI / 2 - 0.001, 9);
          }
          // No step turns the camera round.
          expect(angleBetween(view, prev)).toBeLessThan(0.1);
          prev = { ...view };
        }
        expect(exactSteps).toBeGreaterThan(5);
        expect(heldSteps).toBeGreaterThan(5);
        viewer.dispose();
      });

      it('stops a fling glide when a Safari pinch starts', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0, fov: 70 });
        internals(viewer).rig.flick(25, 5);
        canvasListener(
          viewer,
          'gesturestart',
        )({ scale: 1, clientX: 300, clientY: 300, preventDefault: vi.fn() });
        expect(internals(viewer).rig.momentum).toEqual({ yaw: 0, pitch: 0 });
        viewer.dispose();
      });

      it('keeps a Safari trackpad pinch anchored where it began', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: -0.3, fov: 70 });
        const at = { x: 300, y: 650 };
        const anchor = viewer.directionAtPixel(at.x, at.y);
        const gesture = (type: string, scale: number, x: number, y: number) =>
          canvasListener(viewer, type)({ scale, clientX: x, clientY: y, preventDefault: vi.fn() });
        gesture('gesturestart', 1, at.x, at.y);
        let worst = 0;
        // Changes report a wandering point; the pinch stays where it began.
        for (let i = 1; i <= 25; i++) {
          gesture('gesturechange', 1 + i * 0.08, at.x + i * 3, at.y - i * 2);
          raf.step(raf.now + 16);
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(at.x, at.y), anchor));
        }
        gesture('gestureend', 3, at.x, at.y);
        worst = Math.max(worst, settleKeepingAnchor(viewer, at.x, at.y, anchor, 16));
        expect(internals(viewer).rig.view.fov).toBeLessThan(30);
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('never pans on the sideways jitter of a decaying scroll-zoom tail', () => {
        const viewer = zoomViewer({ yaw: 0.3, pitch: 0.2, fov: 75 });
        const x = 950;
        const y = 600;
        const anchor = viewer.directionAtPixel(x, y);
        let worst = 0;
        // Momentum: deltaY decays well below the steady deltaX of 2 px.
        for (let i = 0; i < 40; i++) {
          wheelAt(viewer, x, y, -30 * 0.88 ** i, 2);
          raf.step(raf.now + 16);
          worst = Math.max(worst, angleBetween(viewer.directionAtPixel(x, y), anchor));
        }
        worst = Math.max(worst, settleKeepingAnchor(viewer, x, y, anchor, 16));
        expect(worst).toBeLessThan(TOL);
        viewer.dispose();
      });

      it('never zooms on the vertical jitter of a sideways swipe', () => {
        const viewer = zoomViewer({ yaw: 0, pitch: 0, fov: 70 });
        for (let i = 0; i < 40; i++) {
          wheelAt(viewer, 600, 400, i % 2 ? 1.5 : -1.5, 30 * 0.88 ** i);
          raf.step(raf.now + 16);
          expect(internals(viewer).rig.view.fov).toBe(70);
        }
        expect(internals(viewer).rig.view.yaw).toBeGreaterThan(0.1);
        viewer.dispose();
      });

      it.each([
        { name: 'zoom in past the zenith', y: 40, pitch: 1.45, dy: -100 },
        { name: 'zoom in toward the zenith', y: 120, pitch: 1.3, dy: -100 },
        { name: 'zoom out by the zenith', y: 80, pitch: 1.45, dy: 100 },
      ])('keeps pitch in its limits without jumping the cursor: $name', ({ y, pitch, dy }) => {
        const limit = Math.PI / 2 - 0.001;
        const viewer = zoomViewer({ yaw: 0, pitch, fov: dy < 0 ? 80 : 30 });
        const x = 650;
        let prev = viewer.directionAtPixel(x, y);
        for (let i = 0; i < 20; i++) {
          wheelAt(viewer, x, y, dy);
          raf.step(raf.now + 16);
          const now = viewer.directionAtPixel(x, y);
          expect(internals(viewer).rig.view.pitch).toBeLessThanOrEqual(limit);
          // Pinned, or (once the clamp holds the camera) a small step, never a jump.
          expect(angleBetween(now, prev)).toBeLessThan(0.05);
          expect(Math.abs(internals(viewer).rig.view.yaw)).toBeLessThan(Math.PI / 2); // no flip over the pole
          prev = now;
        }
        viewer.dispose();
      });
    });
  });
});
