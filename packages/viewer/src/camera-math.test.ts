import { describe, it, expect } from 'vitest';
import {
  clampPitch,
  clampFov,
  damp,
  anglePerPixel,
  zoomAnchorDelta,
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

describe('zoomAnchorDelta', () => {
  it('returns 0 when ndc=0 (centre never shifts)', () => {
    expect(zoomAnchorDelta(0, Math.PI / 3, Math.PI / 6)).toBe(0);
  });

  // The point of the function: the world direction under the cursor keeps
  // its screen position through the zoom. Square aspect, so the horizontal
  // fov equals the vertical one, and pitch 0 keeps the axes independent.
  it.each([
    { ndc: 0.5, fov0: 60, fov1: 30 },
    { ndc: -0.8, fov0: 90, fov1: 40 },
    { ndc: 0.9, fov0: 30, fov1: 75 },
  ])('keeps the cursor at ndc x=$ndc when zooming $fov0°→$fov1°', ({ ndc, fov0, fov1 }) => {
    const yaw0 = 0.4;
    const vp0 = viewProjection({ yaw: yaw0, pitch: 0, fov: fov0 }, 1, 179);
    const world = unprojectNDC(ndc, 0, vp0);
    const yaw1 = yaw0 + zoomAnchorDelta(ndc, (fov0 * Math.PI) / 180, (fov1 * Math.PI) / 180);
    const vp1 = viewProjection({ yaw: yaw1, pitch: 0, fov: fov1 }, 1, 179);
    const p = projectDir(world, vp1);
    expect(p.x).toBeCloseTo(ndc, 6);
    expect(p.y).toBeCloseTo(0, 6);
  });
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
