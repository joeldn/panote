import { describe, expect, it } from 'vitest';

import {
  AnalyticsEventBatchSchema,
  AnalyticsEventSchema,
  MAX_EVENTS_PER_BATCH,
  ViewBeaconSchema,
} from './analytics.js';
import { InsightsOkSchema } from './api.js';

describe('ViewBeaconSchema', () => {
  it('accepts an empty body and a valid panoId/surface', () => {
    expect(ViewBeaconSchema.safeParse({}).success).toBe(true);
    expect(ViewBeaconSchema.safeParse({ panoId: 'p_1-a', surface: 'embed' }).success).toBe(true);
  });

  it.each([{ panoId: '../x' }, { panoId: 'a'.repeat(65) }, { panoId: '' }, { surface: 'iframe' }])(
    'rejects %j',
    (body) => {
      expect(ViewBeaconSchema.safeParse(body).success).toBe(false);
    },
  );
});

describe('AnalyticsEventSchema', () => {
  it('requires ms on dwell only', () => {
    expect(AnalyticsEventSchema.safeParse({ type: 'dwell' }).success).toBe(false);
    expect(AnalyticsEventSchema.safeParse({ type: 'dwell', ms: 10 }).success).toBe(true);
    expect(AnalyticsEventSchema.safeParse({ type: 'scene', panoId: 'p1' }).success).toBe(true);
  });

  it('requires panoId on scene, and panoId plus hotspotId on hotspot', () => {
    const ok = (e: unknown) => AnalyticsEventSchema.safeParse(e).success;
    expect(ok({ type: 'scene' })).toBe(false);
    expect(ok({ type: 'hotspot', panoId: 'p1' })).toBe(false);
    expect(ok({ type: 'hotspot', hotspotId: 'h1' })).toBe(false);
    expect(ok({ type: 'hotspot', panoId: 'p1', hotspotId: 'h1' })).toBe(true);
    expect(ok({ type: 'dwell', ms: 1 })).toBe(true);
  });

  it('reports the missing field by path', () => {
    const r = AnalyticsEventSchema.safeParse({ type: 'hotspot' });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.')).sort()).toEqual(['hotspotId', 'panoId']);
  });

  it.each([
    { type: 'view' },
    { type: 'hotspot', panoId: 'p1', hotspotId: 'has space' },
    { type: 'hotspot', panoId: 'p1', hotspotId: 'h'.repeat(65) },
    { type: 'dwell', ms: Number.NaN },
  ])('rejects %j', (event) => {
    expect(AnalyticsEventSchema.safeParse(event).success).toBe(false);
  });

  it('strips unknown keys', () => {
    const r = AnalyticsEventSchema.parse({ type: 'scene', panoId: 'p1', ip: '1.2.3.4' });
    expect(r).toEqual({ type: 'scene', panoId: 'p1' });
  });
});

describe('AnalyticsEventBatchSchema', () => {
  const batch = (n: number) => ({
    events: Array.from({ length: n }, () => ({ type: 'scene', panoId: 'p1' })),
  });

  it(`caps a batch at ${MAX_EVENTS_PER_BATCH} events`, () => {
    expect(AnalyticsEventBatchSchema.safeParse(batch(MAX_EVENTS_PER_BATCH)).success).toBe(true);
    expect(AnalyticsEventBatchSchema.safeParse(batch(MAX_EVENTS_PER_BATCH + 1)).success).toBe(
      false,
    );
  });
});

describe('InsightsOkSchema', () => {
  it('parses the documented response shape', () => {
    const ok = InsightsOkSchema.safeParse({
      days: 2,
      from: '2026-09-26T00:00:00.000Z',
      to: '2026-09-27T12:00:00.000Z',
      totalViews: 3,
      avgDwellMs: null,
      daily: [
        { date: '2026-09-26', views: 0 },
        { date: '2026-09-27', views: 3 },
      ],
      byPano: [{ panoId: 'p1', views: 3 }],
      topHotspots: [{ panoId: 'p1', hotspotId: 'h1', opens: 1 }],
    });
    expect(ok.success).toBe(true);
  });
});
