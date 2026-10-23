import type { MapPoint, TourWithConfigsOk } from '@internal/contracts';
import { describe, expect, it } from 'vitest';

import {
  SUGGEST_GAP,
  SUGGEST_MARGIN,
  SUGGEST_STEP,
  suggestForTour,
  suggestPositions,
  type SuggestInput,
  type SuggestLink,
} from './map-suggest.js';
import { fromServer } from './model.js';

const EAST = Math.PI / 2;
const WEST = -Math.PI / 2;
const NORTH = 0;

const input = (over: Partial<SuggestInput> & Pick<SuggestInput, 'scenes'>): SuggestInput => ({
  placed: new Map(),
  links: [],
  north: new Map(),
  ...over,
});

const at = (r: { positions: Map<string, MapPoint> }, id: string): MapPoint => {
  const p = r.positions.get(id);
  if (!p) throw new Error(`${id} was not placed`);
  return p;
};

/** Every pair of dots (new and fixed) at least the gap apart, in plan heights. */
function expectApart(points: MapPoint[], ratio = 1) {
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!;
      const b = points[j]!;
      expect(Math.hypot((a.x - b.x) * ratio, a.y - b.y)).toBeGreaterThanOrEqual(SUGGEST_GAP - 1e-3);
    }
  }
}

function expectInside(points: Iterable<MapPoint>) {
  for (const p of points) {
    expect(p.x).toBeGreaterThanOrEqual(SUGGEST_MARGIN - 1e-9);
    expect(p.x).toBeLessThanOrEqual(1 - SUGGEST_MARGIN + 1e-9);
    expect(p.y).toBeGreaterThanOrEqual(SUGGEST_MARGIN - 1e-9);
    expect(p.y).toBeLessThanOrEqual(1 - SUGGEST_MARGIN + 1e-9);
  }
}

describe('suggestPositions', () => {
  it('lays a chain out along its links, one step apart, centred', () => {
    const r = suggestPositions(
      input({
        scenes: ['a', 'b', 'c'],
        links: [
          { from: 'a', to: 'b', yaw: EAST },
          { from: 'b', to: 'c', yaw: EAST },
        ],
        north: new Map([
          ['a', 0],
          ['b', 0],
        ]),
      }),
    );
    expect(r.positions).toEqual(
      new Map([
        ['a', { x: 0.32, y: 0.5 }],
        ['b', { x: 0.5, y: 0.5 }],
        ['c', { x: 0.68, y: 0.5 }],
      ]),
    );
    expect(r).toMatchObject({ fromLinks: 2, noDirection: 0, unlinked: 0 });
  });

  it('reads each link against its own pano’s north', () => {
    // b's north is a quarter turn round, so its link at yaw EAST points north.
    const r = suggestPositions(
      input({
        scenes: ['a', 'b', 'c'],
        links: [
          { from: 'a', to: 'b', yaw: 1 + EAST },
          { from: 'b', to: 'c', yaw: EAST },
        ],
        north: new Map([
          ['a', 1],
          ['b', EAST],
        ]),
      }),
    );
    const [a, b, c] = [at(r, 'a'), at(r, 'b'), at(r, 'c')];
    expect(b.x - a.x).toBeCloseTo(SUGGEST_STEP, 3);
    expect(b.y).toBeCloseTo(a.y, 3);
    expect(c.x).toBeCloseTo(b.x, 3);
    expect(b.y - c.y).toBeCloseTo(SUGGEST_STEP, 3);
  });

  it('turns a corner: an L shape', () => {
    const r = suggestPositions(
      input({
        scenes: ['a', 'b', 'c'],
        links: [
          { from: 'a', to: 'b', yaw: EAST },
          { from: 'b', to: 'c', yaw: NORTH },
        ],
        north: new Map([
          ['a', 0],
          ['b', 0],
        ]),
      }),
    );
    const [a, b, c] = [at(r, 'a'), at(r, 'b'), at(r, 'c')];
    expect(b.y).toBeCloseTo(a.y, 4);
    expect(b.x - a.x).toBeCloseTo(SUGGEST_STEP, 3);
    expect(c.x).toBeCloseTo(b.x, 4);
    expect(b.y - c.y).toBeCloseTo(SUGGEST_STEP, 3);
    expectInside(r.positions.values());
  });

  it('keeps a bearing’s angle on a plan that isn’t square', () => {
    const r = suggestPositions(
      input({
        scenes: ['a', 'b'],
        links: [{ from: 'a', to: 'b', yaw: Math.PI / 4 }],
        north: new Map([['a', 0]]),
        ratio: 2,
      }),
    );
    const [a, b] = [at(r, 'a'), at(r, 'b')];
    // North-east: as far right as up, measured on the plan (x is half as long per unit).
    expect((b.x - a.x) * 2).toBeCloseTo(a.y - b.y, 3);
  });

  it('uses the link back, turned round, when the pano linked from has no north', () => {
    // a has no north; b does, and its link to a points west, so b is east of a.
    const r = suggestPositions(
      input({
        scenes: ['a', 'b'],
        links: [
          { from: 'a', to: 'b', yaw: 2.5 },
          { from: 'b', to: 'a', yaw: 0.4 + WEST },
        ],
        north: new Map([['b', 0.4]]),
      }),
    );
    const [a, b] = [at(r, 'a'), at(r, 'b')];
    expect(b.x - a.x).toBeCloseTo(SUGGEST_STEP, 3);
    expect(b.y).toBeCloseTo(a.y, 3);
    expect(r).toMatchObject({ fromLinks: 1, noDirection: 0 });
  });

  it('still places every pano of a tour with no north set, clear of each other, on the plan', () => {
    const links: SuggestLink[] = [
      { from: 'a', to: 'b', yaw: 0.1 },
      { from: 'a', to: 'c', yaw: 1.2 },
      { from: 'a', to: 'd', yaw: 2.3 },
      { from: 'b', to: 'e', yaw: -1 },
      { from: 'e', to: 'f', yaw: 3 },
      { from: 'f', to: 'a', yaw: -2 },
    ];
    const r = suggestPositions(input({ scenes: ['a', 'b', 'c', 'd', 'e', 'f'], links }));
    expect([...r.positions.keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expectInside(r.positions.values());
    expectApart([...r.positions.values()]);
    expect(r).toMatchObject({ fromLinks: 0, noDirection: 5, unlinked: 0 });
  });

  it('never moves a placed pano, and works at the placed panos’ scale', () => {
    const placed = new Map([
      ['a', { x: 0.3, y: 0.5 }],
      ['c', { x: 0.3, y: 0.2 }],
    ]);
    const r = suggestPositions(
      input({
        scenes: ['a', 'b', 'c'],
        placed,
        links: [
          { from: 'a', to: 'b', yaw: EAST },
          { from: 'a', to: 'c', yaw: NORTH },
        ],
        north: new Map([['a', 0]]),
      }),
    );
    expect([...r.positions.keys()]).toEqual(['b']);
    // a and c are 0.3 apart, so a link is 0.3 long here.
    expect(at(r, 'b').x).toBeCloseTo(0.6, 4);
    expect(at(r, 'b').y).toBeCloseTo(0.5, 4);
    expect(placed.get('a')).toEqual({ x: 0.3, y: 0.5 });
  });

  it('puts a pano several placed ones link to at the mean of where they say', () => {
    const r = suggestPositions(
      input({
        scenes: ['a', 'b', 'c'],
        placed: new Map([
          ['a', { x: 0.3, y: 0.5 }],
          ['c', { x: 0.5, y: 0.5 }],
        ]),
        links: [
          { from: 'a', to: 'b', yaw: EAST },
          { from: 'c', to: 'b', yaw: NORTH },
        ],
        north: new Map([
          ['a', 0],
          ['c', 0],
        ]),
      }),
    );
    expect(at(r, 'b').x).toBeCloseTo((0.3 + SUGGEST_STEP + 0.5) / 2, 4);
    expect(at(r, 'b').y).toBeCloseTo((0.5 + 0.5 - SUGGEST_STEP) / 2, 4);
  });

  it('keeps a suggestion off a placed dot and inside the plan', () => {
    const placed = new Map([
      ['a', { x: 0.9, y: 0.5 }],
      ['c', { x: 0.92, y: 0.5 }],
    ]);
    const r = suggestPositions(
      input({
        scenes: ['a', 'b', 'c'],
        placed,
        links: [{ from: 'a', to: 'b', yaw: EAST }],
        north: new Map([['a', 0]]),
      }),
    );
    expectInside(r.positions.values());
    expectApart([at(r, 'b'), placed.get('a')!]);
    expectApart([at(r, 'b'), placed.get('c')!]);
  });

  it('places a pano with no links clear of the rest', () => {
    const r = suggestPositions(
      input({
        scenes: ['a', 'b', 'c'],
        links: [{ from: 'a', to: 'b', yaw: EAST }],
        north: new Map([['a', 0]]),
      }),
    );
    expect(r).toMatchObject({ fromLinks: 1, noDirection: 0, unlinked: 1 });
    expect(r.positions.size).toBe(3);
    expectInside(r.positions.values());
    expectApart([...r.positions.values()]);
    // The linked pair still keep their direction.
    expect(at(r, 'b').y).toBeCloseTo(at(r, 'a').y, 4);
    expect(at(r, 'b').x).toBeGreaterThan(at(r, 'a').x);
  });

  it('puts a lone pano in the middle', () => {
    const r = suggestPositions(input({ scenes: ['a'] }));
    expect(r.positions).toEqual(new Map([['a', { x: 0.5, y: 0.5 }]]));
  });

  it('starts from the tour’s start pano', () => {
    const tour = (start: string) =>
      suggestPositions(
        input({ scenes: ['a', 'b'], links: [{ from: 'a', to: 'b', yaw: 0.3 }], start }),
      );
    // Without a direction the start goes first and the other goes north of it.
    expect(tour('b').positions).toEqual(
      new Map([
        ['b', { x: 0.5, y: 0.59 }],
        ['a', { x: 0.5, y: 0.41 }],
      ]),
    );
    expect(at(tour('a'), 'a').y).toBeGreaterThan(at(tour('a'), 'b').y);
  });

  it('has nothing to suggest when every pano is placed', () => {
    const r = suggestPositions(
      input({ scenes: ['a'], placed: new Map([['a', { x: 0.1, y: 0.1 }]]) }),
    );
    expect(r.positions.size).toBe(0);
  });

  it('gives the same answer every time', () => {
    const big = input({
      scenes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      placed: new Map([['d', { x: 0.7, y: 0.3 }]]),
      links: [
        { from: 'a', to: 'b', yaw: 0.3 },
        { from: 'b', to: 'c', yaw: 2 },
        { from: 'c', to: 'd', yaw: -1 },
        { from: 'd', to: 'e', yaw: 1 },
        { from: 'f', to: 'a', yaw: 0 },
      ],
      north: new Map([
        ['b', 0.2],
        ['d', -0.5],
      ]),
      ratio: 1.5,
    });
    const first = suggestPositions(big);
    expect(suggestPositions(big)).toEqual(first);
    expect(first.positions.size).toBe(6);
    expectInside(first.positions.values());
    expectApart([...first.positions.values(), { x: 0.7, y: 0.3 }], 1.5);
  });
});

describe('suggestForTour', () => {
  it('reads the links and norths from the panos, and the placed dots from the tour', () => {
    const res: TourWithConfigsOk = {
      tour: {
        tourId: 't1',
        title: 'Old town',
        scenes: [{ panoId: 'a', mapX: 0.3, mapY: 0.5 }, { panoId: 'b' }, { panoId: 'gone' }],
      },
      etag: 'te',
      publish: null,
      configs: {
        a: {
          config: {
            panoId: 'a',
            title: 'Square',
            north: 0,
            hotspots: [
              { id: 'l1', type: 'link', yaw: EAST, pitch: -0.4, title: 'B', targetPanoId: 'b' },
              { id: 'i1', type: 'info', yaw: NORTH, pitch: 0, title: 'Info' },
            ],
          },
          etag: 'ea',
        },
        b: { config: { panoId: 'b', title: 'Church', hotspots: [] }, etag: 'eb' },
      },
    };
    const r = suggestForTour(fromServer(res), 1);
    expect(at(r, 'b')).toEqual({ x: 0.3 + SUGGEST_STEP, y: 0.5 });
    expect(r.positions.has('a')).toBe(false);
    expect(r.positions.has('gone')).toBe(true);
    expect(r).toMatchObject({ fromLinks: 1, unlinked: 1 });
  });
});
