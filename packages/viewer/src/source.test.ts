import { describe, expect, it } from 'vitest';

import { FACES } from './cube.js';
import {
  MAX_SOURCE_LEVEL,
  assertSource,
  urlTemplateSource,
  type CubeTileSource,
} from './source.js';

describe('urlTemplateSource', () => {
  it('fills the template for every tile, exactly', () => {
    const s = urlTemplateSource({
      id: 'p1',
      template: 'https://cdn.example/p1/{level}/{face}/{x}-{y}.jpg',
      tileSize: 512,
      maxLevel: 3,
    });
    expect(s.tileUrl!({ face: 'px', level: 0, x: 0, y: 0 })).toBe(
      'https://cdn.example/p1/0/px/0-0.jpg',
    );
    expect(s.tileUrl!({ face: 'nz', level: 3, x: 7, y: 5 })).toBe(
      'https://cdn.example/p1/3/nz/7-5.jpg',
    );
    expect(s).toMatchObject({ id: 'p1', tileSize: 512, maxLevel: 3 });
    expect(s.version).toBeUndefined();
    expect(s.loadTile).toBeUndefined();
  });

  it('maps face ids through faceNames, leaving the unmapped ones as they are', () => {
    const s = urlTemplateSource({
      id: 'p1',
      template: '/t/{face}_{level}_{y}_{x}.webp',
      tileSize: 256,
      maxLevel: 1,
      faceNames: { pz: 'f', nz: 'b', px: 'r' },
    });
    expect(FACES.map((face) => s.tileUrl!({ face, level: 1, x: 1, y: 0 }))).toEqual([
      '/t/r_1_0_1.webp',
      '/t/nx_1_0_1.webp',
      '/t/py_1_0_1.webp',
      '/t/ny_1_0_1.webp',
      '/t/f_1_0_1.webp',
      '/t/b_1_0_1.webp',
    ]);
  });

  it('replaces every occurrence and does not encode', () => {
    const s = urlTemplateSource({
      id: 'p 1',
      template: '/a b/{face}/{level}/{face}/{x}-{y}?l={level}',
      tileSize: 512,
      maxLevel: 0,
    });
    expect(s.tileUrl!({ face: 'py', level: 0, x: 0, y: 0 })).toBe('/a b/py/0/py/0-0?l=0');
  });

  it('carries version and meta through', () => {
    const meta = { any: 'thing' };
    const s = urlTemplateSource({
      id: 'p1',
      template: '/{level}/{face}/{x}-{y}',
      tileSize: 512,
      maxLevel: 0,
      version: 'v2',
      meta,
    });
    expect(s.version).toBe('v2');
    expect(s.meta).toBe(meta);
  });

  it.each(['{level}', '{face}', '{x}', '{y}'])('refuses a template without %s', (p) => {
    const template = '/{level}/{face}/{x}-{y}.jpg'.replace(p, 'z');
    expect(() => urlTemplateSource({ id: 'p1', template, tileSize: 512, maxLevel: 0 })).toThrow(
      `template has no ${p}`,
    );
  });

  it('refuses a malformed pyramid', () => {
    expect(() =>
      urlTemplateSource({
        id: 'p1',
        template: '/{level}/{face}/{x}-{y}',
        tileSize: 0,
        maxLevel: 0,
      }),
    ).toThrow(TypeError);
  });
});

describe('assertSource', () => {
  const ok: CubeTileSource = { id: 's', tileSize: 512, maxLevel: 2, tileUrl: () => '/t' };

  it('accepts a tileUrl or a loadTile source', () => {
    expect(() => assertSource(ok)).not.toThrow();
    expect(() =>
      assertSource({
        id: 's',
        tileSize: 512,
        maxLevel: MAX_SOURCE_LEVEL,
        loadTile: () => new Promise(() => {}),
      }),
    ).not.toThrow();
    expect(() => assertSource({ ...ok, tileBorder: 0 })).not.toThrow();
  });

  it.each<[string, Partial<CubeTileSource>, string]>([
    ['an empty id', { id: '' }, 'id must be a non-empty string'],
    ['a fractional tileSize', { tileSize: 511.5 }, 'tileSize must be a positive integer'],
    ['a zero tileSize', { tileSize: 0 }, 'tileSize must be a positive integer'],
    ['a negative maxLevel', { maxLevel: -1 }, 'maxLevel must be a non-negative integer'],
    ['a fractional maxLevel', { maxLevel: 1.5 }, 'maxLevel must be a non-negative integer'],
    [
      'too deep a pyramid',
      { maxLevel: MAX_SOURCE_LEVEL + 1 },
      `maxLevel must be <= ${MAX_SOURCE_LEVEL}`,
    ],
    [
      'no way to get tiles',
      { tileUrl: undefined } as unknown as Partial<CubeTileSource>,
      'needs tileUrl or loadTile',
    ],
    ['a tile border', { tileBorder: 2 }, 'tileBorder is not supported yet'],
  ])('refuses %s', (_, over, message) => {
    expect(() => assertSource({ ...ok, ...over })).toThrow(
      new TypeError(`tile source "${over.id ?? 's'}": ${message}`),
    );
  });
});
