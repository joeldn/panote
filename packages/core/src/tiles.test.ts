import { describe, it, expect } from 'vitest';
import { tilesPerEdge, tileSubRect, tileCornersUV } from './tiles.js';

describe('tilesPerEdge', () => {
  it('is 2^level', () => {
    expect(tilesPerEdge(0)).toBe(1);
    expect(tilesPerEdge(1)).toBe(2);
    expect(tilesPerEdge(4)).toBe(16);
  });
});

describe('tileSubRect', () => {
  it('covers the whole face at level 0', () => {
    expect(tileSubRect(0, 0, 0)).toEqual({ u0: 0, v0: 0, u1: 1, v1: 1 });
  });

  it('splits the face into quadrants at level 1', () => {
    expect(tileSubRect(1, 0, 0)).toEqual({ u0: 0, v0: 0, u1: 0.5, v1: 0.5 });
    expect(tileSubRect(1, 1, 1)).toEqual({ u0: 0.5, v0: 0.5, u1: 1, v1: 1 });
  });
});

describe('tileCornersUV', () => {
  it('returns the four UV corners of a tile in TL,TR,BL,BR order', () => {
    expect(tileCornersUV(1, 0, 0)).toEqual([
      { u: 0, v: 0 },
      { u: 0.5, v: 0 },
      { u: 0, v: 0.5 },
      { u: 0.5, v: 0.5 },
    ]);
  });
});
