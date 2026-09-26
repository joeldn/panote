import { describe, it, expect } from 'vitest';
import {
  HotspotSchema,
  MAX_HOTSPOT_BODY_LENGTH,
  MAX_HOTSPOTS,
  MAX_TOUR_SCENES,
  SceneConfigSchema,
  TourDocSchema,
  TourSceneSchema,
  ViewSchema,
} from './schema.js';

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

  // Proves a pre-Wave-6 stored doc (no north/media/icon/size fields) still
  // parses now that those fields exist as optional additions.
  it('parses an old-shape doc with no new fields, defaulting them to undefined', () => {
    const r = SceneConfigSchema.parse({
      panoId: 'p1',
      title: 'Hall',
      description: 'A hallway',
      initialView: { yaw: 0.1, pitch: -0.2, fov: 60 },
      hotspots: [{ id: 'h1', type: 'info', yaw: 0, pitch: 0, title: 'Info' }],
    });
    expect(r.north).toBeUndefined();
    expect(r.hotspots[0]?.icon).toBeUndefined();
    expect(r.hotspots[0]?.size).toBeUndefined();
    expect(r.hotspots[0]?.media).toBeUndefined();
  });

  it('accepts a north offset and round-trips it', () => {
    const r = SceneConfigSchema.parse({ panoId: 'p1', title: 'Hall', hotspots: [], north: 1.2 });
    expect(r.north).toBe(1.2);
  });

  it.each([Math.PI + 0.01, -Math.PI - 0.01])('rejects a north offset %j outside [-π, π]', (n) => {
    expect(() =>
      SceneConfigSchema.parse({ panoId: 'p1', title: 'Hall', hotspots: [], north: n }),
    ).toThrow();
  });

  it(`rejects more than MAX_HOTSPOTS (${MAX_HOTSPOTS}) hotspots`, () => {
    const hotspots = Array.from({ length: MAX_HOTSPOTS + 1 }, (_, i) => ({
      id: `h${i}`,
      type: 'info' as const,
      yaw: 0,
      pitch: 0,
      title: 'Info',
    }));
    expect(() => SceneConfigSchema.parse({ panoId: 'p1', title: 'Hall', hotspots })).toThrow();
  });

  it('accepts exactly MAX_HOTSPOTS hotspots', () => {
    const hotspots = Array.from({ length: MAX_HOTSPOTS }, (_, i) => ({
      id: `h${i}`,
      type: 'info' as const,
      yaw: 0,
      pitch: 0,
      title: 'Info',
    }));
    expect(() => SceneConfigSchema.parse({ panoId: 'p1', title: 'Hall', hotspots })).not.toThrow();
  });
});

describe('ViewSchema bounds (radians for yaw/pitch, degrees for fov)', () => {
  it('accepts values at the documented bounds', () => {
    expect(() => ViewSchema.parse({ yaw: Math.PI, pitch: -Math.PI / 2, fov: 15 })).not.toThrow();
    expect(() => ViewSchema.parse({ yaw: -Math.PI, pitch: Math.PI / 2, fov: 80 })).not.toThrow();
  });

  it.each([
    { yaw: Math.PI + 0.01, pitch: 0, fov: 60 },
    { yaw: 0, pitch: Math.PI / 2 + 0.01, fov: 60 },
    { yaw: 0, pitch: 0, fov: 14 },
    { yaw: 0, pitch: 0, fov: 81 },
  ])('rejects an out-of-bounds view %j', (view) => {
    expect(() => ViewSchema.parse(view)).toThrow();
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

  // tourId is used verbatim in tourKey() for the same reason panoId is above.
  it.each(['a/b', 'probe tour|1', 'ünïcøde', ''])(
    'rejects a tourId %j outside the URL-unreserved charset',
    (tourId) => {
      expect(() => TourDocSchema.parse({ tourId, title: 'WWII', scenes: [] })).toThrow();
    },
  );

  // Proves a pre-Wave-6 stored tour (no startPanoId/settings) still parses.
  it('parses an old-shape tour with no new fields', () => {
    const r = TourDocSchema.parse({ tourId: 't1', title: 'WWII', scenes: [{ panoId: 'a' }] });
    expect(r.startPanoId).toBeUndefined();
    expect(r.settings).toBeUndefined();
  });

  it('accepts startPanoId and settings and round-trips them', () => {
    const r = TourDocSchema.parse({
      tourId: 't1',
      title: 'WWII',
      scenes: [{ panoId: 'a' }],
      startPanoId: 'a',
      settings: { controls: 'top', showMap: true, showCompass: false, autoRotate: true },
    });
    expect(r.startPanoId).toBe('a');
    expect(r.settings).toEqual({
      controls: 'top',
      showMap: true,
      showCompass: false,
      autoRotate: true,
    });
  });

  it('rejects a startPanoId outside PANO_PATTERN', () => {
    expect(() =>
      TourDocSchema.parse({ tourId: 't1', title: 'WWII', scenes: [], startPanoId: 'a/b' }),
    ).toThrow();
  });

  it('rejects settings with an invalid controls value', () => {
    expect(() =>
      TourDocSchema.parse({
        tourId: 't1',
        title: 'WWII',
        scenes: [],
        settings: { controls: 'left', showMap: true, showCompass: false, autoRotate: true },
      }),
    ).toThrow();
  });

  it('rejects settings missing a required key', () => {
    expect(() =>
      TourDocSchema.parse({
        tourId: 't1',
        title: 'WWII',
        scenes: [],
        settings: { controls: 'top', showMap: true },
      }),
    ).toThrow();
  });

  it(`rejects more than MAX_TOUR_SCENES (${MAX_TOUR_SCENES}) scenes (unchanged cap)`, () => {
    const scenes = Array.from({ length: MAX_TOUR_SCENES + 1 }, (_, i) => ({ panoId: `s${i}` }));
    expect(() => TourDocSchema.parse({ tourId: 't1', title: 'WWII', scenes })).toThrow();
  });
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

describe('HotspotSchema icon/size/media/body', () => {
  const base = { id: 'h1', type: 'info' as const, yaw: 0, pitch: 0, title: 'Info' };

  it('parses an old-shape hotspot with no new fields', () => {
    const r = HotspotSchema.parse(base);
    expect(r.icon).toBeUndefined();
    expect(r.size).toBeUndefined();
    expect(r.media).toBeUndefined();
  });

  it('accepts a valid icon, size and media, round-tripped', () => {
    const r = HotspotSchema.parse({
      ...base,
      icon: 'map-pin',
      size: 1.5,
      media: { kind: 'youtube', id: 'dQw4w9WgXcQ' },
    });
    expect(r.icon).toBe('map-pin');
    expect(r.size).toBe(1.5);
    expect(r.media).toEqual({ kind: 'youtube', id: 'dQw4w9WgXcQ' });
  });

  it.each(['Map-Pin', 'map_pin', 'a'.repeat(41), ''])('rejects an invalid icon name %j', (icon) => {
    expect(() => HotspotSchema.parse({ ...base, icon })).toThrow();
  });

  it.each([0.49, 3.01])('rejects a size %j outside [0.5, 3]', (size) => {
    expect(() => HotspotSchema.parse({ ...base, size })).toThrow();
  });

  it.each([0.5, 3])('accepts a size %j at the bounds', (size) => {
    expect(() => HotspotSchema.parse({ ...base, size })).not.toThrow();
  });

  it('accepts an image/video media with an https url', () => {
    expect(() =>
      HotspotSchema.parse({ ...base, media: { kind: 'image', url: 'https://example.com/a.jpg' } }),
    ).not.toThrow();
  });

  it('rejects a media url that is not https', () => {
    expect(() =>
      HotspotSchema.parse({ ...base, media: { kind: 'image', url: 'http://example.com/a.jpg' } }),
    ).toThrow();
  });

  it('rejects a media kind outside image/video/youtube', () => {
    expect(() =>
      HotspotSchema.parse({ ...base, media: { kind: 'audio', url: 'https://example.com/a.mp3' } }),
    ).toThrow();
  });

  it(`rejects a body longer than MAX_HOTSPOT_BODY_LENGTH (${MAX_HOTSPOT_BODY_LENGTH})`, () => {
    expect(() =>
      HotspotSchema.parse({ ...base, body: 'x'.repeat(MAX_HOTSPOT_BODY_LENGTH + 1) }),
    ).toThrow();
  });

  it('accepts a body exactly MAX_HOTSPOT_BODY_LENGTH long', () => {
    expect(() =>
      HotspotSchema.parse({ ...base, body: 'x'.repeat(MAX_HOTSPOT_BODY_LENGTH) }),
    ).not.toThrow();
  });

  it.each([Math.PI + 0.01, -Math.PI - 0.01])('rejects a yaw %j outside [-π, π]', (yaw) => {
    expect(() => HotspotSchema.parse({ ...base, yaw })).toThrow();
  });

  it.each([Math.PI / 2 + 0.01, -Math.PI / 2 - 0.01])(
    'rejects a pitch %j outside [-π/2, π/2]',
    (pitch) => {
      expect(() => HotspotSchema.parse({ ...base, pitch })).toThrow();
    },
  );
});
