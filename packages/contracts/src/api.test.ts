import { describe, it, expect } from 'vitest';
import { PanoConfigOkSchema, TourOkSchema } from './api.js';

describe('PanoConfigOkSchema canonicalizes legacy out-of-range angles/fov', () => {
  it('parses a legacy doc (fov 90, hotspot yaw 5, hotspot pitch 2) to canonical values', () => {
    const r = PanoConfigOkSchema.parse({
      etag: 'abc',
      config: {
        panoId: 'p1',
        title: 'Hall',
        initialView: { yaw: 0, pitch: 0, fov: 90 },
        hotspots: [{ id: 'h1', type: 'info', yaw: 5, pitch: 2, title: 'Info' }],
      },
    });
    expect(r.config.initialView?.fov).toBe(80);
    expect(r.config.hotspots[0]?.yaw).toBeCloseTo(5 - 2 * Math.PI);
    expect(r.config.hotspots[0]?.pitch).toBeCloseTo(Math.PI / 2);
  });
});

describe('TourOkSchema publish field', () => {
  const tour = { tourId: 't1', title: 'T', scenes: [] };
  it('accepts a response without publish (pre-B2), null, or a publish state', () => {
    expect(TourOkSchema.parse({ tour, etag: 'e' }).publish).toBeUndefined();
    expect(TourOkSchema.parse({ tour, etag: 'e', publish: null }).publish).toBeNull();
    const publish = {
      slug: 'tour',
      visibility: 'unlisted',
      publishedAt: '2026-09-27T00:00:00.000Z',
    };
    expect(TourOkSchema.parse({ tour, etag: 'e', publish }).publish).toEqual(publish);
  });
});
