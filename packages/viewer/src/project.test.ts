import { describe, it, expect } from 'vitest';
import { dirFromYawPitch, dirInto, ndcToPixel, isBehind } from './project.js';

describe('ndcToPixel', () => {
  it('maps NDC center to container center', () => {
    expect(ndcToPixel(0, 0, 800, 600)).toEqual({ x: 400, y: 300 });
  });
  it('maps NDC (-1,1) top-left to (0,0)', () => {
    expect(ndcToPixel(-1, 1, 800, 600)).toEqual({ x: 0, y: 0 });
  });
  it('maps NDC (1,-1) bottom-right to (w,h)', () => {
    expect(ndcToPixel(1, -1, 800, 600)).toEqual({ x: 800, y: 600 });
  });
});

describe('isBehind', () => {
  it('is true when direction opposes camera forward', () => {
    expect(isBehind({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 })).toBe(true);
  });
  it('is false when direction aligns with forward', () => {
    expect(isBehind({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -1 })).toBe(false);
  });
});

describe('out-params', () => {
  it('ndcToPixel writes into and returns the given object', () => {
    const out = { x: 0, y: 0, behind: true };
    expect(ndcToPixel(0, 0, 800, 600, out)).toBe(out);
    expect(out).toEqual({ x: 400, y: 300, behind: true });
  });

  it('dirInto matches dirFromYawPitch and returns the given object', () => {
    const out = { x: 0, y: 0, z: 0 };
    expect(dirInto(out, 0.7, -0.3)).toBe(out);
    expect(out).toEqual(dirFromYawPitch(0.7, -0.3));
  });
});
