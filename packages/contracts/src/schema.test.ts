import { describe, it, expect } from 'vitest';
import { HotspotSchema, SceneConfigSchema, TourDocSchema, TourSceneSchema } from './schema.js';

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

  // panoId is used verbatim in the R2 key (see keys.ts), so it's
  // restricted to PANO_PATTERN at the schema boundary.
  it.each(['a/b', 'probe pano|1', 'slash/probe/1', 'ünïcøde', '100%', ''])(
    'rejects a panoId %j outside the URL-unreserved charset',
    (panoId) => {
      expect(() => SceneConfigSchema.parse({ panoId, title: 'Hall', hotspots: [] })).toThrow();
    },
  );

  it.each(['p1', '550e8400-e29b-41d4-a716-446655440000', 'a_b-C9'])(
    'accepts a panoId %j inside the URL-unreserved charset',
    (panoId) => {
      expect(() => SceneConfigSchema.parse({ panoId, title: 'Hall', hotspots: [] })).not.toThrow();
    },
  );
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

  // tourId is used verbatim in tourKey() for the same reason panoId is above.
  it.each(['a/b', 'probe tour|1', 'ünïcøde', ''])(
    'rejects a tourId %j outside the URL-unreserved charset',
    (tourId) => {
      expect(() => TourDocSchema.parse({ tourId, title: 'WWII', scenes: [] })).toThrow();
    },
  );
});

describe('TourSceneSchema.panoId', () => {
  it('accepts a UUID', () => {
    expect(() =>
      TourSceneSchema.parse({ panoId: '550e8400-e29b-41d4-a716-446655440000' }),
    ).not.toThrow();
  });

  it.each(['a|b', 'a b', 'a/b', ''])('rejects a panoId %j outside PANO_PATTERN', (panoId) => {
    expect(() => TourSceneSchema.parse({ panoId })).toThrow();
  });
});

describe('HotspotSchema.targetPanoId', () => {
  const base = { id: 'h1', type: 'link' as const, yaw: 0, pitch: 0, title: 'next' };

  it('accepts a UUID', () => {
    expect(() =>
      HotspotSchema.parse({ ...base, targetPanoId: '550e8400-e29b-41d4-a716-446655440000' }),
    ).not.toThrow();
  });

  it('accepts an absent targetPanoId on a non-link hotspot', () => {
    expect(() =>
      HotspotSchema.parse({ id: 'h1', type: 'info', yaw: 0, pitch: 0, title: 'info' }),
    ).not.toThrow();
  });

  it.each(['a|b', 'a b', 'a/b'])(
    'rejects a targetPanoId %j outside PANO_PATTERN',
    (targetPanoId) => {
      expect(() => HotspotSchema.parse({ ...base, targetPanoId })).toThrow();
    },
  );

  it('rejects an empty-string targetPanoId even on a non-link hotspot (fails the regex, not the link-requires-target refine)', () => {
    expect(() =>
      HotspotSchema.parse({
        id: 'h1',
        type: 'info',
        yaw: 0,
        pitch: 0,
        title: 'info',
        targetPanoId: '',
      }),
    ).toThrow();
  });
});
