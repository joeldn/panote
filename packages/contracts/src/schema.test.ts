import { describe, it, expect } from 'vitest';
import { SceneConfigSchema, TourDocSchema } from './schema.js';

describe('SceneConfigSchema', () => {
  it('accepts a minimal scene', () => {
    const r = SceneConfigSchema.parse({
      panoId: 'p1',
      title: 'Hall',
      hotspots: [],
    });
    expect(r.hotspots).toEqual([]);
  });
  it('rejects a link hotspot with no target', () => {
    expect(() =>
      SceneConfigSchema.parse({
        panoId: 'p1',
        title: 'Hall',
        hotspots: [{ id: 'h1', type: 'link', yaw: 0, pitch: 0, title: 'next' }],
      }),
    ).toThrow();
  });
});

describe('TourDocSchema', () => {
  it('accepts a tour with two scenes', () => {
    const r = TourDocSchema.parse({
      tourId: 't1',
      title: 'WWII',
      scenes: [{ panoId: 'a' }, { panoId: 'b' }],
    });
    expect(r.scenes).toHaveLength(2);
  });
});
