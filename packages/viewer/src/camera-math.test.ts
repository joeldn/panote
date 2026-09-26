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
  it('moves halfway with factor 0.5', () => {
    expect(damp(0, 10, 0.5)).toBe(5);
  });

  it('returns same value when current equals target', () => {
    expect(damp(5, 5, 0.3)).toBe(5);
  });

  it('reaches target in one step with factor 1', () => {
    expect(damp(3, 10, 1)).toBe(10);
  });

  it('converges toward target after repeated application', () => {
    let v = 0;
    for (let i = 0; i < 50; i++) {
      v = damp(v, 10, 0.3);
    }
    expect(v).toBeCloseTo(10, 3);
  });

  it('never moves with factor 0', () => {
    expect(damp(3, 10, 0)).toBe(3);
  });
});

describe('anglePerPixel', () => {
  it('returns a positive value', () => {
    expect(anglePerPixel(Math.PI / 2, 800)).toBeGreaterThan(0);
  });

  it('doubling dimensionPx halves the result', () => {
    const fov = Math.PI / 3;
    expect(anglePerPixel(fov, 400)).toBeCloseTo(anglePerPixel(fov, 800) * 2, 10);
  });

  it('larger fov yields a larger value (90° vs 45°)', () => {
    expect(anglePerPixel((90 * Math.PI) / 180, 800)).toBeGreaterThan(
      anglePerPixel((45 * Math.PI) / 180, 800),
    );
  });
});

describe('zoomAnchorDelta', () => {
  it('returns 0 when ndc=0 (centre never shifts)', () => {
    expect(zoomAnchorDelta(0, Math.PI / 3, Math.PI / 6)).toBe(0);
  });

  it('returns > 0 for ndc>0 and fov1<fov0 (zoom in)', () => {
    const fov0 = (60 * Math.PI) / 180;
    const fov1 = (30 * Math.PI) / 180;
    expect(zoomAnchorDelta(0.5, fov0, fov1)).toBeGreaterThan(0);
  });

  it('has odd symmetry: zoomAnchorDelta(-n,a,b) === -zoomAnchorDelta(n,a,b)', () => {
    const fov0 = (60 * Math.PI) / 180;
    const fov1 = (30 * Math.PI) / 180;
    expect(zoomAnchorDelta(-0.5, fov0, fov1)).toBeCloseTo(-zoomAnchorDelta(0.5, fov0, fov1), 10);
  });

  it('returns 0 when fov0 === fov1', () => {
    const fov = (45 * Math.PI) / 180;
    expect(zoomAnchorDelta(0.7, fov, fov)).toBeCloseTo(0, 10);
  });
});

describe('pinchFactor', () => {
  it('returns > 1 when pinching in (dist < prevDist, zooms out)', () => {
    expect(pinchFactor(200, 100)).toBeGreaterThan(1);
  });

  it('returns < 1 when pinching out (dist > prevDist, zooms in)', () => {
    expect(pinchFactor(100, 200)).toBeLessThan(1);
  });

  it('returns 1 when distance is unchanged', () => {
    expect(pinchFactor(150, 150)).toBe(1);
  });

  it('equals prevDist / dist', () => {
    expect(pinchFactor(300, 150)).toBeCloseTo(2, 10);
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
