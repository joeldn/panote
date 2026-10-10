import { describe, it, expect } from 'vitest';
// Core is imported here only to prove the vendored conventions match the
// tiler's: tiles are written with core's faceUVToDir and drawn with ours.
import * as core from '@panote/core';
import { FACES, equirectUVToDir, faceUVToDir, tileCornersUV, tilesPerEdge } from './cube.js';

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

describe('parity with @panote/core', () => {
  it('lists the same faces in the same order', () => {
    expect(FACES).toEqual(core.FACES);
  });

  it('maps every face UV to the same direction as the tiler', () => {
    for (const face of FACES) {
      for (let i = 0; i <= 8; i++) {
        for (let j = 0; j <= 8; j++) {
          expect(faceUVToDir(face, i / 8, j / 8)).toEqual(core.faceUVToDir(face, i / 8, j / 8));
        }
      }
    }
  });

  it('agrees on tiles per edge', () => {
    for (let level = 0; level <= 5; level++) {
      expect(tilesPerEdge(level)).toBe(core.tilesPerEdge(level));
    }
  });

  it('inverts the tiler’s equirect mapping', () => {
    for (const u of [0.01, 0.25, 0.5, 0.73, 0.99]) {
      for (const v of [0.02, 0.3, 0.5, 0.81, 0.98]) {
        const back = core.dirToEquirectUV(equirectUVToDir(u, v));
        expect(near(back.u, u)).toBe(true);
        expect(near(back.v, v)).toBe(true);
      }
    }
  });
});

describe('faceUVToDir', () => {
  it('maps face centres to the axis directions', () => {
    expect(faceUVToDir('px', 0.5, 0.5)).toEqual({ x: 1, y: 0, z: 0 });
    expect(faceUVToDir('nx', 0.5, 0.5)).toEqual({ x: -1, y: 0, z: 0 });
    expect(faceUVToDir('py', 0.5, 0.5)).toEqual({ x: 0, y: 1, z: 0 });
    expect(faceUVToDir('ny', 0.5, 0.5)).toEqual({ x: 0, y: -1, z: 0 });
    expect(faceUVToDir('pz', 0.5, 0.5)).toEqual({ x: 0, y: 0, z: 1 });
    expect(faceUVToDir('nz', 0.5, 0.5)).toEqual({ x: 0, y: 0, z: -1 });
  });

  it('maps the top-left corner of px to {x:1, y:1, z:1}', () => {
    expect(faceUVToDir('px', 0, 0)).toEqual({ x: 1, y: 1, z: 1 });
  });
});

describe('equirectUVToDir', () => {
  it('maps the centre to -z (front) and the top edge to +y', () => {
    const front = equirectUVToDir(0.5, 0.5);
    expect(near(front.x, 0) && near(front.y, 0) && near(front.z, -1)).toBe(true);
    expect(near(equirectUVToDir(0.3, 0).y, 1)).toBe(true);
  });
});

describe('tilesPerEdge', () => {
  it('is 2^level', () => {
    expect(tilesPerEdge(0)).toBe(1);
    expect(tilesPerEdge(1)).toBe(2);
    expect(tilesPerEdge(4)).toBe(16);
  });
});

describe('tileCornersUV', () => {
  it('covers the whole face at level 0', () => {
    expect(tileCornersUV(0, 0, 0)).toEqual([
      { u: 0, v: 0 },
      { u: 1, v: 0 },
      { u: 0, v: 1 },
      { u: 1, v: 1 },
    ]);
  });

  it('returns the four UV corners of a tile in TL,TR,BL,BR order', () => {
    expect(tileCornersUV(1, 0, 0)).toEqual([
      { u: 0, v: 0 },
      { u: 0.5, v: 0 },
      { u: 0, v: 0.5 },
      { u: 0.5, v: 0.5 },
    ]);
    expect(tileCornersUV(1, 1, 1)).toEqual([
      { u: 0.5, v: 0.5 },
      { u: 1, v: 0.5 },
      { u: 0.5, v: 1 },
      { u: 1, v: 1 },
    ]);
  });
});
