import { describe, it, expect } from 'vitest';
import {
  HotspotSchema,
  MAX_HOTSPOT_BODY_LENGTH,
  MAX_HOTSPOT_ID_LENGTH,
  MAX_HOTSPOTS,
  MAX_SCENE_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
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

  // The viewer's yaw is deliberately unbounded (PanoViewer.ts pan/momentum/
  // setNorth), so a finite north outside (-π, π] is wrapped, not rejected.
  it('wraps a north offset outside (-π, π] instead of rejecting it', () => {
    const r = SceneConfigSchema.parse({
      panoId: 'p1',
      title: 'Hall',
      hotspots: [],
      north: 3.2,
    });
    expect(r.north).toBeCloseTo(3.2 - 2 * Math.PI);
  });

  it.each([NaN, Infinity, -Infinity])('rejects a non-finite north %j', (n) => {
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

  it(`rejects a title longer than MAX_TITLE_LENGTH (${MAX_TITLE_LENGTH})`, () => {
    expect(() =>
      SceneConfigSchema.parse({ panoId: 'p1', title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }),
    ).toThrow();
  });

  it('accepts a title exactly MAX_TITLE_LENGTH long', () => {
    expect(() =>
      SceneConfigSchema.parse({ panoId: 'p1', title: 'x'.repeat(MAX_TITLE_LENGTH) }),
    ).not.toThrow();
  });

  it(`rejects a description longer than MAX_SCENE_DESCRIPTION_LENGTH (${MAX_SCENE_DESCRIPTION_LENGTH})`, () => {
    expect(() =>
      SceneConfigSchema.parse({
        panoId: 'p1',
        title: 'Hall',
        description: 'x'.repeat(MAX_SCENE_DESCRIPTION_LENGTH + 1),
      }),
    ).toThrow();
  });

  it('accepts a description exactly MAX_SCENE_DESCRIPTION_LENGTH long', () => {
    expect(() =>
      SceneConfigSchema.parse({
        panoId: 'p1',
        title: 'Hall',
        description: 'x'.repeat(MAX_SCENE_DESCRIPTION_LENGTH),
      }),
    ).not.toThrow();
  });
});

describe('ViewSchema bounds (radians for yaw/pitch, degrees for fov)', () => {
  it('accepts values at the documented bounds', () => {
    expect(() => ViewSchema.parse({ yaw: Math.PI, pitch: -Math.PI / 2, fov: 15 })).not.toThrow();
    expect(() => ViewSchema.parse({ yaw: -Math.PI, pitch: Math.PI / 2, fov: 80 })).not.toThrow();
  });

  // yaw/pitch/fov are all canonicalized (wrapped or clamped), not bounded -
  // see the schema.ts comment above ViewSchema for why. Only a non-finite
  // value is rejected.
  it.each([
    [3.2, 3.2 - 2 * Math.PI],
    [-7, -7 + 2 * Math.PI],
    [-Math.PI, Math.PI],
  ])('wraps a yaw of %j to %j instead of rejecting it', (yaw, expected) => {
    const r = ViewSchema.parse({ yaw, pitch: 0, fov: 60 });
    expect(r.yaw).toBeCloseTo(expected);
  });

  it.each([
    [Math.PI / 2 + 0.5, Math.PI / 2],
    [-Math.PI / 2 - 0.5, -Math.PI / 2],
  ])('clamps a pitch of %j to %j instead of rejecting it', (pitch, expected) => {
    const r = ViewSchema.parse({ yaw: 0, pitch, fov: 60 });
    expect(r.pitch).toBeCloseTo(expected);
  });

  it.each([
    [90, 80],
    [5, 15],
  ])('clamps a fov of %j to %j instead of rejecting it', (fov, expected) => {
    const r = ViewSchema.parse({ yaw: 0, pitch: 0, fov });
    expect(r.fov).toBe(expected);
  });

  it.each([NaN, Infinity, -Infinity])('rejects a non-finite yaw %j', (yaw) => {
    expect(() => ViewSchema.parse({ yaw, pitch: 0, fov: 60 })).toThrow();
  });

  it.each([NaN, Infinity, -Infinity])('rejects a non-finite pitch %j', (pitch) => {
    expect(() => ViewSchema.parse({ yaw: 0, pitch, fov: 60 })).toThrow();
  });

  it.each([NaN, Infinity, -Infinity])('rejects a non-finite fov %j', (fov) => {
    expect(() => ViewSchema.parse({ yaw: 0, pitch: 0, fov })).toThrow();
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

  it(`rejects a title longer than MAX_TITLE_LENGTH (${MAX_TITLE_LENGTH})`, () => {
    expect(() =>
      TourDocSchema.parse({ tourId: 't1', title: 'x'.repeat(MAX_TITLE_LENGTH + 1), scenes: [] }),
    ).toThrow();
  });

  it('accepts a title exactly MAX_TITLE_LENGTH long', () => {
    expect(() =>
      TourDocSchema.parse({ tourId: 't1', title: 'x'.repeat(MAX_TITLE_LENGTH), scenes: [] }),
    ).not.toThrow();
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

  it.each(['image', 'video'] as const)('accepts a %s media with an https url', (kind) => {
    expect(() =>
      HotspotSchema.parse({ ...base, media: { kind, url: 'https://example.com/a.jpg' } }),
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

  it.each(['image', 'video'] as const)('rejects a %s media with no url', (kind) => {
    expect(() => HotspotSchema.parse({ ...base, media: { kind } })).toThrow();
  });

  it('rejects a youtube media with no id', () => {
    expect(() => HotspotSchema.parse({ ...base, media: { kind: 'youtube' } })).toThrow();
  });

  it('rejects a youtube id containing path characters', () => {
    expect(() =>
      HotspotSchema.parse({ ...base, media: { kind: 'youtube', id: 'a/b/c-1234' } }),
    ).toThrow();
  });

  it('rejects a youtube id of the wrong length', () => {
    expect(() =>
      HotspotSchema.parse({ ...base, media: { kind: 'youtube', id: 'short' } }),
    ).toThrow();
  });

  it('accepts a valid 11-char youtube id', () => {
    expect(() =>
      HotspotSchema.parse({ ...base, media: { kind: 'youtube', id: 'dQw4w9WgXcQ' } }),
    ).not.toThrow();
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

  it('wraps a hotspot yaw outside (-π, π] instead of rejecting it', () => {
    const r = HotspotSchema.parse({ ...base, yaw: 3.2 });
    expect(r.yaw).toBeCloseTo(3.2 - 2 * Math.PI);
  });

  it.each([NaN, Infinity, -Infinity])('rejects a non-finite hotspot yaw %j', (yaw) => {
    expect(() => HotspotSchema.parse({ ...base, yaw })).toThrow();
  });

  it.each([
    [Math.PI / 2 + 0.5, Math.PI / 2],
    [-Math.PI / 2 - 0.5, -Math.PI / 2],
  ])('clamps a hotspot pitch of %j to %j instead of rejecting it', (pitch, expected) => {
    const r = HotspotSchema.parse({ ...base, pitch });
    expect(r.pitch).toBeCloseTo(expected);
  });

  it.each([NaN, Infinity, -Infinity])('rejects a non-finite hotspot pitch %j', (pitch) => {
    expect(() => HotspotSchema.parse({ ...base, pitch })).toThrow();
  });

  it(`rejects a title longer than MAX_TITLE_LENGTH (${MAX_TITLE_LENGTH})`, () => {
    expect(() =>
      HotspotSchema.parse({ ...base, title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }),
    ).toThrow();
  });

  it('accepts a title exactly MAX_TITLE_LENGTH long', () => {
    expect(() =>
      HotspotSchema.parse({ ...base, title: 'x'.repeat(MAX_TITLE_LENGTH) }),
    ).not.toThrow();
  });

  it(`rejects an id longer than MAX_HOTSPOT_ID_LENGTH (${MAX_HOTSPOT_ID_LENGTH})`, () => {
    expect(() =>
      HotspotSchema.parse({ ...base, id: 'x'.repeat(MAX_HOTSPOT_ID_LENGTH + 1) }),
    ).toThrow();
  });

  it('accepts an id exactly MAX_HOTSPOT_ID_LENGTH long', () => {
    expect(() =>
      HotspotSchema.parse({ ...base, id: 'x'.repeat(MAX_HOTSPOT_ID_LENGTH) }),
    ).not.toThrow();
  });

  it('rejects a media url longer than MAX_MEDIA_URL_LENGTH', () => {
    const overlong = `https://example.com/${'a'.repeat(2048)}.jpg`;
    expect(() =>
      HotspotSchema.parse({ ...base, media: { kind: 'image', url: overlong } }),
    ).toThrow();
  });
});
