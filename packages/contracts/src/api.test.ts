import { describe, it, expect } from 'vitest';
import {
  PANO_DELETE_CONFLICTS,
  PanoConfigOkSchema,
  PanoDeleteConflictSchema,
  PanoStatusSchema,
  PanoSummarySchema,
  TourOkSchema,
} from './api.js';

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

describe('PanoSummarySchema referenced field', () => {
  const pano = {
    panoId: 'p1',
    title: null,
    hasConfig: false,
    hasOriginal: true,
    deleting: false,
    tiling: 'ready',
    manifest: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  it('is optional, so a list without ?include=references still parses', () => {
    expect(PanoSummarySchema.parse(pano).referenced).toBeUndefined();
    expect(PanoSummarySchema.parse({ ...pano, referenced: false }).referenced).toBe(false);
  });
  it('is not part of the per-pano status', () => {
    expect('referenced' in PanoStatusSchema.shape).toBe(false);
  });
});

describe('PanoDeleteConflictSchema', () => {
  it('accepts every refusal the delete route sends, and nothing else', () => {
    for (const error of Object.values(PANO_DELETE_CONFLICTS)) {
      expect(PanoDeleteConflictSchema.safeParse({ error }).success).toBe(true);
    }
    expect(PanoDeleteConflictSchema.safeParse({ error: 'conflict' }).success).toBe(false);
  });
});
