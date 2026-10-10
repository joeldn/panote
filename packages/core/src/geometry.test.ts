import { describe, it, expect } from 'vitest';
import { faceUVToDir, dirToEquirectUV, FACES } from './geometry.js';

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

describe('FACES', () => {
  it('lists the six faces in canonical order', () => {
    expect(FACES).toEqual(['px', 'nx', 'py', 'ny', 'pz', 'nz']);
  });
});

describe('faceUVToDir', () => {
  it('maps face centers to the expected axis directions', () => {
    expect(faceUVToDir('px', 0.5, 0.5)).toEqual({ x: 1, y: 0, z: 0 });
    expect(faceUVToDir('nx', 0.5, 0.5)).toEqual({ x: -1, y: 0, z: 0 });
    expect(faceUVToDir('py', 0.5, 0.5)).toEqual({ x: 0, y: 1, z: 0 });
    expect(faceUVToDir('ny', 0.5, 0.5)).toEqual({ x: 0, y: -1, z: 0 });
    expect(faceUVToDir('pz', 0.5, 0.5)).toEqual({ x: 0, y: 0, z: 1 });
    expect(faceUVToDir('nz', 0.5, 0.5)).toEqual({ x: 0, y: 0, z: -1 });
  });

  it('maps the top-left corner of px to {x:1, y:1, z:1}', () => {
    const d = faceUVToDir('px', 0.0, 0.0);
    expect(d.x).toBe(1);
    expect(d.y).toBe(1); // top of px (v=0 -> tc=-1 -> -tc=+1)
    expect(d.z).toBe(1); // left of px (u=0 -> sc=-1 -> -sc=+1)
  });
});

describe('dirToEquirectUV', () => {
  it('maps +x to u=0.75, equator v=0.5', () => {
    const { u, v } = dirToEquirectUV({ x: 1, y: 0, z: 0 });
    expect(near(u, 0.75)).toBe(true);
    expect(near(v, 0.5)).toBe(true);
  });

  it('maps +y (up) to the top row v=0', () => {
    const { v } = dirToEquirectUV({ x: 0, y: 1, z: 0 });
    expect(near(v, 0)).toBe(true);
  });

  it('maps -y (down) to the bottom row v=1', () => {
    const { v } = dirToEquirectUV({ x: 0, y: -1, z: 0 });
    expect(near(v, 1)).toBe(true);
  });

  it('maps -z (front) to u=0.5', () => {
    const { u } = dirToEquirectUV({ x: 0, y: 0, z: -1 });
    expect(near(u, 0.5)).toBe(true);
  });

  it('wraps u into [0,1)', () => {
    const { u } = dirToEquirectUV({ x: 0, y: 0, z: 1 });
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
  });

  it('wraps +z (the seam) to u≈0', () => {
    const { u } = dirToEquirectUV({ x: 0, y: 0, z: 1 });
    expect(near(u, 0)).toBe(true);
  });
});

describe('faceUVToDir off-center', () => {
  it('maps an off-center point on pz to the correct octant', () => {
    // u>0.5 on pz moves toward +x; center is front (z=1)
    const d = faceUVToDir('pz', 0.75, 0.5);
    expect(d.z).toBe(1);
    expect(d.x).toBeGreaterThan(0);
    expect(d.y).toBe(0);
  });
});
