import { describe, expect, it } from 'vitest';

import { roundView, sameParams, viewFromParams, withView } from './view-url.js';

const DEG = Math.PI / 180;
const q = (s: string) => new URLSearchParams(s);

describe('viewFromParams', () => {
  it('reads degrees into radians, each axis on its own', () => {
    const v = viewFromParams(q('yaw=90&pitch=-10&fov=50'))!;
    expect(v.yaw).toBeCloseTo(90 * DEG, 9);
    expect(v.pitch).toBeCloseTo(-10 * DEG, 9);
    expect(v.fov).toBe(50);
    expect(viewFromParams(q('fov=40'))).toEqual({ fov: 40 });
  });

  it('drops what is not a number or out of range, and is null with nothing left', () => {
    expect(viewFromParams(q('yaw=&pitch=91&fov=0'))).toBeNull();
    expect(viewFromParams(q('yaw=east&fov=180'))).toBeNull();
    expect(viewFromParams(q('pano=hall'))).toBeNull();
  });
});

describe('roundView', () => {
  it('rounds to whole degrees, yaw into (-180, 180], never -0', () => {
    expect(roundView({ yaw: 359.6 * DEG, pitch: -0.2 * DEG, fov: 70.4 })).toEqual({
      yaw: 0,
      pitch: 0,
      fov: 70,
    });
    expect(roundView({ yaw: -180 * DEG, pitch: 0, fov: 70 }).yaw).toBe(180);
    expect(roundView({ yaw: 3 * Math.PI, pitch: 0, fov: 70 }).yaw).toBe(180);
  });
});

describe('withView', () => {
  it('sets the scene and camera, keeping other params', () => {
    const out = withView(q('lang=de&yaw=1'), 'hall', { yaw: 0, pitch: 0, fov: 60 });
    expect(out.toString()).toBe('lang=de&pano=hall&yaw=0&pitch=0&fov=60');
  });

  it('drops the camera for a scene alone', () => {
    expect(withView(q('pano=a&yaw=1&pitch=2&fov=3'), 'b', null).toString()).toBe('pano=b');
  });
});

describe('sameParams', () => {
  it('ignores order', () => {
    expect(sameParams(q('a=1&b=2'), q('b=2&a=1'))).toBe(true);
    expect(sameParams(q('a=1'), q('a=2'))).toBe(false);
  });
});
