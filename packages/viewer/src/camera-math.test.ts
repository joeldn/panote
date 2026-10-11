import { describe, it, expect } from 'vitest';
import {
  clampPitch,
  clampFov,
  damp,
  anglePerPixel,
  zoomAnchorView,
  rayAt,
  aimRay,
  pinchFactor,
  normalizeAngle,
  compassHeading,
} from './camera-math.js';
import { viewProjection, projectDir, unprojectNDC } from './render/projection.js';

describe('clampPitch', () => {
  it('clamps to just under ±90°', () => {
    expect(clampPitch(Math.PI)).toBeCloseTo(Math.PI / 2 - 0.001, 3);
    expect(clampPitch(-Math.PI)).toBeCloseTo(-(Math.PI / 2 - 0.001), 3);
    expect(clampPitch(0.1)).toBeCloseTo(0.1, 5);
  });
});

describe('clampFov', () => {
  it('clamps into [min,max]', () => {
    expect(clampFov(5, 15, 90)).toBe(15);
    expect(clampFov(120, 15, 90)).toBe(90);
    expect(clampFov(45, 15, 90)).toBe(45);
  });
});

describe('damp', () => {
  it.each([
    { current: 0, target: 10, factor: 0.5, want: 5 },
    { current: 5, target: 5, factor: 0.3, want: 5 },
    { current: 3, target: 10, factor: 1, want: 10 },
    { current: 3, target: 10, factor: 0, want: 3 },
  ])('damp($current, $target, $factor) = $want', ({ current, target, factor, want }) => {
    expect(damp(current, target, factor)).toBe(want);
  });
});

describe('anglePerPixel', () => {
  it('is 2·tan(fov/2) / dimension', () => {
    // tan(π/4) = 1, so a 90° fov across 800 px is exactly 2/800.
    expect(anglePerPixel(Math.PI / 2, 800)).toBeCloseTo(2 / 800, 15);
  });
});

describe('zoomAnchorView', () => {
  const D = Math.PI / 180;
  const LIMIT = Math.PI / 2 - 0.001;
  const tan = (fovDeg: number) => Math.tan((fovDeg * D) / 2);

  it('leaves the camera alone for the centre of the screen', () => {
    const out = zoomAnchorView({ yaw: 0, pitch: 0 }, 0.4, 0.3, 0, 0, 1, 1, 0.5, 0.5, -LIMIT, LIMIT);
    expect(out.yaw).toBeCloseTo(0.4, 12);
    expect(out.pitch).toBeCloseTo(0.3, 12);
  });

  // The world direction under the point keeps its screen position through
  // the zoom: off the centre lines and pitched, where treating yaw and pitch
  // as two independent screen axes drifts.
  it.each([
    { nx: 0.5, ny: 0, pitch: 0, aspect: 1, fov0: 60, fov1: 30 },
    { nx: -0.8, ny: 0, pitch: 0, aspect: 1, fov0: 90, fov1: 40 },
    { nx: 0.9, ny: 0, pitch: 0, aspect: 1, fov0: 30, fov1: 75 },
    { nx: 0.75, ny: 0.7, pitch: 0, aspect: 1.5, fov0: 70, fov1: 50 },
    { nx: 0.75, ny: 0.7, pitch: 0.6, aspect: 1.5, fov0: 70, fov1: 50 },
    { nx: -0.9, ny: -0.8, pitch: -0.7, aspect: 0.5, fov0: 25, fov1: 70 },
    { nx: 0.2, ny: 0.5, pitch: 1.2, aspect: 2, fov0: 60, fov1: 20 },
  ])(
    'keeps ndc ($nx, $ny) still at pitch $pitch, $fov0° → $fov1°',
    ({ nx, ny, pitch, aspect, fov0, fov1 }) => {
      const yaw0 = 0.4;
      const vp0 = viewProjection({ yaw: yaw0, pitch, fov: fov0 }, aspect, 179);
      const world = unprojectNDC(nx, ny, vp0);
      const { yaw, pitch: pitch1 } = zoomAnchorView(
        { yaw: 0, pitch: 0 },
        yaw0,
        pitch,
        nx,
        ny,
        tan(fov0) * aspect,
        tan(fov0),
        tan(fov1) * aspect,
        tan(fov1),
        -LIMIT,
        LIMIT,
      );
      const p = projectDir(world, viewProjection({ yaw, pitch: pitch1, fov: fov1 }, aspect, 179));
      // The matrices are float32.
      expect(p.x).toBeCloseTo(nx, 6);
      expect(p.y).toBeCloseTo(ny, 6);
    },
  );

  it.each([
    { yaw0: Math.PI - 0.05, nx: 0.9 },
    { yaw0: -Math.PI + 0.05, nx: -0.9 },
    { yaw0: 7, nx: 0.8 },
  ])('gives the yaw nearest $yaw0, unwrapped across ±π', ({ yaw0, nx }) => {
    const { yaw } = zoomAnchorView(
      { yaw: 0, pitch: 0 },
      yaw0,
      0.2,
      nx,
      0.3,
      tan(80) * 1.5,
      tan(80),
      tan(30) * 1.5,
      tan(30),
      -LIMIT,
      LIMIT,
    );
    // Zooming in toward the side turns toward it by a fraction of a turn.
    expect(Math.sign(yaw - yaw0)).toBe(Math.sign(nx));
    expect(Math.abs(yaw - yaw0)).toBeLessThan(0.6);
  });

  it('holds pitch to its limits and gives the yaw nearest the start', () => {
    const out = zoomAnchorView(
      { yaw: 0, pitch: 0 },
      7,
      1.4,
      0.5,
      0.9,
      tan(80),
      tan(80),
      tan(20),
      tan(20),
      -1.45,
      1.45,
    );
    expect(out.pitch).toBe(1.45);
    expect(Math.abs(out.yaw - 7)).toBeLessThan(Math.PI);
  });
});

describe('rayAt and aimRay', () => {
  const D = Math.PI / 180;
  const LIMIT = Math.PI / 2 - 0.001;

  // A pinch moves the scene point between the fingers to a new screen point
  // at a new fov: the world ray from one screen point, aimed at another.
  it.each([
    { from: [0.2, 0.1], to: [-0.5, 0.6], pitch: 0.3, fov0: 70, fov1: 40, aspect: 1.5 },
    { from: [-0.7, -0.4], to: [0.3, -0.8], pitch: -0.6, fov0: 30, fov1: 60, aspect: 0.6 },
    { from: [0, 0.6], to: [0.02, 0.4], pitch: 1.2, fov0: 70, fov1: 35, aspect: 1.5 },
  ])(
    'puts the ray from $from under $to at pitch $pitch',
    ({ from, to, pitch, fov0, fov1, aspect }) => {
      const ty0 = Math.tan((fov0 * D) / 2);
      const ty1 = Math.tan((fov1 * D) / 2);
      const world = unprojectNDC(
        from[0]!,
        from[1]!,
        viewProjection({ yaw: 1, pitch, fov: fov0 }, aspect, 179),
      );
      const ray = rayAt({ yaw: 0, pitch: 0 }, 1, pitch, from[0]! * ty0 * aspect, from[1]! * ty0);
      const cam = aimRay(
        { yaw: 0, pitch: 0 },
        ray.yaw,
        ray.pitch,
        to[0]! * ty1 * aspect,
        to[1]! * ty1,
        1,
        pitch,
        -LIMIT,
        LIMIT,
      );
      expect(Math.abs(cam.yaw - 1)).toBeLessThan(Math.PI);
      const p = projectDir(
        world,
        viewProjection({ yaw: cam.yaw, pitch: cam.pitch, fov: fov1 }, aspect, 179),
      );
      expect(p.x).toBeCloseTo(to[0]!, 6);
      expect(p.y).toBeCloseTo(to[1]!, 6);
    },
  );
});

describe('pinchFactor', () => {
  it.each([
    { prev: 200, dist: 100, want: 2 }, // pinch in, zooms out
    { prev: 100, dist: 200, want: 0.5 }, // pinch out, zooms in
    { prev: 150, dist: 150, want: 1 },
  ])('pinchFactor($prev, $dist) = $want', ({ prev, dist, want }) => {
    expect(pinchFactor(prev, dist)).toBe(want);
  });
});

describe('normalizeAngle', () => {
  it('leaves an already-wrapped angle unchanged', () => {
    expect(normalizeAngle(0.3)).toBeCloseTo(0.3, 10);
    expect(normalizeAngle(-0.3)).toBeCloseTo(-0.3, 10);
  });

  it('wraps an angle past +π back down', () => {
    expect(normalizeAngle(Math.PI * 1.5)).toBeCloseTo(-Math.PI / 2, 10);
  });

  it('wraps an angle past −π back up', () => {
    expect(normalizeAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2, 10);
  });

  it('maps −π to +π (half-open at the negative end)', () => {
    expect(normalizeAngle(-Math.PI)).toBeCloseTo(Math.PI, 10);
  });

  it('wraps several full turns the same as none', () => {
    expect(normalizeAngle(0.7 + Math.PI * 4)).toBeCloseTo(0.7, 10);
  });
});

describe('compassHeading', () => {
  it('is 0 when north lines up with the current yaw', () => {
    expect(compassHeading(1.2, 1.2)).toBeCloseTo(0, 10);
  });

  it('is north minus yaw, wrapped', () => {
    expect(compassHeading(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 10);
    expect(compassHeading(Math.PI / 2, 0)).toBeCloseTo(-Math.PI / 2, 10);
  });

  it('wraps across the ±π seam', () => {
    // yaw and north sit on opposite sides of the seam, 0.2 rad apart the short way.
    expect(compassHeading(-Math.PI + 0.1, Math.PI - 0.1)).toBeCloseTo(-0.2, 10);
  });
});
