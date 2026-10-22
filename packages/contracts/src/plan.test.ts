import { describe, expect, it } from 'vitest';

import { PLANS_ROOT, planKey, planPrefix } from './keys.js';
import { fitMapPositions, isUnitMap, MAX_PLAN_EDGE, toMapCoord } from './plan.js';
import { PublishedTourSchema } from './publish.js';
import { TourDocSchema, TourPlanSchema } from './schema.js';

const PLAN_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('plan keys', () => {
  it('lives under the public pub/ prefix, owner-free', () => {
    expect(PLANS_ROOT).toBe('pub/plans/');
    expect(planPrefix('t1')).toBe('pub/plans/t1/');
    expect(planKey('t1', PLAN_ID, 'image/webp')).toBe(`pub/plans/t1/${PLAN_ID}.webp`);
    expect(planKey('t1', PLAN_ID, 'image/jpeg')).toBe(`pub/plans/t1/${PLAN_ID}.jpg`);
    expect(planKey('t1', PLAN_ID, 'image/png')).toBe(`pub/plans/t1/${PLAN_ID}.png`);
  });

  it('refuses ids that could escape the prefix', () => {
    expect(() => planPrefix('../tours')).toThrow();
    expect(() => planKey('t1', 'a/b', 'image/png')).toThrow();
  });
});

describe('TourPlanSchema', () => {
  const plan = { id: PLAN_ID, type: 'image/webp', width: 1600, height: 900 };

  it('accepts a plan and rides along on a tour and a bundle', () => {
    expect(TourPlanSchema.parse(plan)).toEqual(plan);
    expect(TourDocSchema.parse({ tourId: 't1', title: 'T', plan }).plan).toEqual(plan);
    const bundle = {
      v: 1,
      tourId: 't1',
      title: 'T',
      visibility: 'public',
      slug: 'a-tour',
      publishedAt: '2026-10-22T00:00:00.000Z',
      settings: { controls: 'bottom', showMap: true, showCompass: true, autoRotate: false },
      startPanoId: 'p1',
      plan,
      scenes: [],
    };
    expect(PublishedTourSchema.parse(bundle).plan).toEqual(plan);
  });

  it('refuses other types, bad ids and out-of-range sizes', () => {
    expect(TourPlanSchema.safeParse({ ...plan, type: 'image/svg+xml' }).success).toBe(false);
    expect(TourPlanSchema.safeParse({ ...plan, id: '../x' }).success).toBe(false);
    expect(TourPlanSchema.safeParse({ ...plan, width: 0 }).success).toBe(false);
    expect(TourPlanSchema.safeParse({ ...plan, height: MAX_PLAN_EDGE + 1 }).success).toBe(false);
    expect(TourPlanSchema.safeParse({ ...plan, width: 10.5 }).success).toBe(false);
  });

  it('is optional, so tours without one still parse', () => {
    expect(TourDocSchema.parse({ tourId: 't1', title: 'T' }).plan).toBeUndefined();
  });
});

describe('fitMapPositions', () => {
  it('keeps 0..1 positions as they are', () => {
    const m = new Map([
      ['a', { x: 0, y: 1 }],
      ['b', { x: 0.25, y: 0.5 }],
    ]);
    expect(isUnitMap(m.values())).toBe(true);
    expect(fitMapPositions(m)).toEqual(m);
  });

  it('fits older, unit-free positions into the plan as the viewer always drew them', () => {
    const m = new Map([
      ['a', { x: 10, y: 5 }],
      ['b', { x: 30, y: 5 }],
      ['c', { x: 20, y: 105 }],
    ]);
    expect(isUnitMap(m.values())).toBe(false);
    const fitted = fitMapPositions(m);
    expect(fitted.get('a')).toEqual({ x: 0.08, y: 0.08 });
    expect(fitted.get('b')!.x).toBeCloseTo(0.92);
    expect(fitted.get('b')!.y).toBeCloseTo(0.08);
    expect(fitted.get('c')!.x).toBeCloseTo(0.5);
    expect(fitted.get('c')!.y).toBeCloseTo(0.92);
  });

  it('centres an axis where every value is the same', () => {
    const fitted = fitMapPositions(
      new Map([
        ['a', { x: 3, y: 7 }],
        ['b', { x: 3, y: 9 }],
      ]),
    );
    expect(fitted.get('a')!.x).toBe(0.5);
  });
});

describe('toMapCoord', () => {
  it('clamps to the plan and rounds', () => {
    expect(toMapCoord(-0.2)).toBe(0);
    expect(toMapCoord(1.4)).toBe(1);
    expect(toMapCoord(0.123456)).toBe(0.1235);
    expect(toMapCoord(NaN)).toBe(0.5);
  });
});
