import { describe, expect, it } from 'vitest';

import { lookFromOrientation, smoothLook, wrapAngle, yawFor } from './gyro.js';

const DEG = Math.PI / 180;
const look = (alpha: number, beta: number, gamma: number, screen = 0) =>
  lookFromOrientation({ alpha, beta, gamma }, screen)!;
const deg = (l: { heading: number; pitch: number }) => ({
  // `|| 0`: a -0 reads the same as 0 here.
  heading: Math.round(l.heading / DEG) || 0,
  pitch: Math.round(l.pitch / DEG) || 0,
});

describe('lookFromOrientation', () => {
  it('looks at the horizon, north, with the phone held upright facing north', () => {
    expect(deg(look(0, 90, 0))).toEqual({ heading: 0, pitch: 0 });
  });

  it('turns right as the phone turns right (alpha falls, heading and yaw grow)', () => {
    expect(deg(look(-90, 90, 0))).toEqual({ heading: 90, pitch: 0 });
    expect(deg(look(90, 90, 0))).toEqual({ heading: -90, pitch: 0 });
  });

  it('looks up and down as the phone tilts back and forward', () => {
    expect(deg(look(0, 135, 0))).toEqual({ heading: 0, pitch: 45 });
    expect(deg(look(0, 45, 0))).toEqual({ heading: 0, pitch: -45 });
  });

  it('keeps a heading straight down and straight up, where Euler angles lock', () => {
    // Flat on a table, screen up, top to the north: looking down, facing north.
    expect(deg(look(0, 0, 0))).toEqual({ heading: 0, pitch: -90 });
    // The same, turned to face east.
    expect(deg(look(-90, 0, 0))).toEqual({ heading: 90, pitch: -90 });
    // Held overhead, screen down, top to the south: looking up, still facing north.
    expect(deg(look(0, 180, 0))).toEqual({ heading: 0, pitch: 90 });
  });

  it('moves smoothly through the pole rather than flipping', () => {
    let prev = look(0, 3, 0).heading;
    for (let beta = 2; beta >= -2; beta -= 0.5) {
      const h = look(0, beta, 0).heading;
      expect(Math.abs(wrapAngle(h - prev))).toBeLessThan(5 * DEG);
      prev = h;
    }
  });

  it('ignores roll: a phone upright facing north and tipped sideways still looks north', () => {
    // Rx(90)·Rz(30) as the spec's Z-X'-Y'' angles: the Euler angles jump, the look doesn't.
    expect(deg(look(90, 60, -90))).toEqual({ heading: 0, pitch: 0 });
    expect(deg(look(-90, 60, 90))).toEqual({ heading: 0, pitch: 0 });
  });

  it('follows the screen into landscape', () => {
    // Turned a quarter counterclockwise (angle 90): the device's right edge is up.
    // Upright in landscape facing north: alpha 90, gamma -90.
    expect(deg(look(90, 0, -90, 90))).toEqual({ heading: 0, pitch: 0 });
    expect(deg(look(0, 0, -90, 90))).toEqual({ heading: 90, pitch: 0 });
    // Flat, looking down, with the landscape top (the device's right edge) to the north:
    // the screen's up decides the heading here, so the angle matters.
    expect(deg(look(90, 0, 0, 90))).toEqual({ heading: 0, pitch: -90 });
    expect(deg(look(90, 0, 0, 0))).toEqual({ heading: -90, pitch: -90 });
    // Upside-down landscape (angle 270): the device's left edge is up.
    expect(deg(look(-90, 0, 0, 270))).toEqual({ heading: 0, pitch: -90 });
  });

  it('gives nothing without readings', () => {
    expect(lookFromOrientation({ alpha: null, beta: null, gamma: null })).toBeNull();
  });
});

describe('smoothLook', () => {
  it('starts at the first reading', () => {
    const first = { heading: 1, pitch: 0.2 };
    expect(smoothLook(null, first, 0.3)).toBe(first);
  });

  it('moves part of the way, the short way round past ±π', () => {
    const next = smoothLook({ heading: 3, pitch: 0 }, { heading: -3, pitch: 1 }, 0.5);
    // From 3 to -3 the short way is +0.28 rad across π, not -6 back through 0.
    expect(next.heading).toBeCloseTo(wrapAngle(3 + (2 * Math.PI - 6) / 2), 6);
    expect(next.pitch).toBeCloseTo(0.5, 6);
  });
});

describe('yawFor', () => {
  it('adds the offset fixed when the control went on, wrapped', () => {
    expect(yawFor({ heading: 0.5, pitch: 0 }, 0.25)).toBeCloseTo(0.75, 6);
    expect(yawFor({ heading: 3, pitch: 0 }, 1)).toBeCloseTo(4 - 2 * Math.PI, 6);
  });
});
