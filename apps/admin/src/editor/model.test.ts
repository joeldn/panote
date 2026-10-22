import { MAX_TITLE_LENGTH, type TourWithConfigsOk } from '@internal/contracts';
import { describe, expect, it } from 'vitest';

import {
  dirtyKeys,
  editorReducer,
  findLink,
  fromServer,
  mergeAppendedScenes,
  normalizeAngle,
  pointSizeForDrag,
  sameValue,
  yawDegrees,
  type EditorAction,
  type EditorDocs,
} from './model.js';

const server: TourWithConfigsOk = {
  tour: {
    tourId: 't1',
    title: 'Old town',
    scenes: [{ panoId: 'a' }, { panoId: 'b' }, { panoId: 'gone' }, { panoId: 'fresh' }],
    startPanoId: 'b',
  },
  etag: 'te',
  publish: null,
  configs: {
    a: { config: { panoId: 'a', title: 'Square', hotspots: [] }, etag: 'ea' },
    b: { config: { panoId: 'b', title: 'Church', hotspots: [] }, etag: 'eb' },
    gone: { missing: true, deleting: false, hasOriginal: false },
    fresh: { missing: true, deleting: false, hasOriginal: true },
  },
};

const run = (...actions: EditorAction[]): EditorDocs =>
  actions.reduce<EditorDocs | null>(editorReducer, fromServer(server))!;

const configOf = (docs: EditorDocs, id: string) => {
  const s = docs.scenes[id];
  if (s?.kind !== 'config') throw new Error(`${id} has no config`);
  return s;
};

describe('editor model', () => {
  it('maps a missing config to a Missing scene and an untitled original to a creatable one', () => {
    const docs = fromServer(server);
    expect(docs.scenes.gone).toEqual({ kind: 'missing', deleting: false });
    expect(configOf(docs, 'fresh')).toMatchObject({
      etag: null,
      current: { title: 'Untitled pano' },
    });
    expect(dirtyKeys(docs)).toEqual([]);
  });

  it('tracks dirtiness per document and ignores key order', () => {
    const docs = run(
      { type: 'scene/title', panoId: 'a', title: 'Plaza' },
      { type: 'tour/title', title: 'New' },
    );
    expect(dirtyKeys(docs).sort()).toEqual(['pano:a', 'tour']);
    const back = run(
      { type: 'scene/title', panoId: 'a', title: 'Plaza' },
      { type: 'scene/title', panoId: 'a', title: 'Square' },
    );
    expect(dirtyKeys(back)).toEqual([]);
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });

  it('aims, nudges and removes a connection as a link hotspot', () => {
    let docs = run({ type: 'link/set', from: 'a', to: 'b', yaw: 1, title: 'Church' });
    const link = findLink(configOf(docs, 'a').current, 'b');
    expect(link).toMatchObject({ type: 'link', targetPanoId: 'b', yaw: 1, title: 'Church' });
    docs = editorReducer(docs, { type: 'link/set', from: 'a', to: 'b', yaw: 2, title: 'x' })!;
    expect(configOf(docs, 'a').current.hotspots).toHaveLength(1);
    expect(findLink(configOf(docs, 'a').current, 'b')?.yaw).toBe(2);
    docs = editorReducer(docs, { type: 'link/nudge', from: 'a', to: 'b', delta: 2 })!;
    expect(findLink(configOf(docs, 'a').current, 'b')?.yaw).toBeCloseTo(4 - 2 * Math.PI);
    docs = editorReducer(docs, { type: 'link/remove', from: 'a', to: 'b' })!;
    expect(configOf(docs, 'a').current.hotspots).toEqual([]);
  });

  it('adds, patches (clearing optional fields with null) and removes points', () => {
    let docs = run({
      type: 'point/add',
      panoId: 'a',
      hotspot: { id: 'p1', type: 'info', yaw: 7, pitch: 0.1, title: 'Fountain' },
    });
    expect(configOf(docs, 'a').current.hotspots[0]?.yaw).toBeCloseTo(7 - 2 * Math.PI);
    docs = editorReducer(docs, {
      type: 'point/update',
      panoId: 'a',
      id: 'p1',
      patch: { icon: 'star', size: 2, media: { kind: 'youtube', id: 'dQw4w9WgXcQ' } },
    })!;
    expect(configOf(docs, 'a').current.hotspots[0]).toMatchObject({ icon: 'star', size: 2 });
    docs = editorReducer(docs, {
      type: 'point/update',
      panoId: 'a',
      id: 'p1',
      patch: { icon: null },
    })!;
    expect(configOf(docs, 'a').current.hotspots[0]).not.toHaveProperty('icon');
    docs = editorReducer(docs, { type: 'point/remove', panoId: 'a', id: 'p1' })!;
    expect(configOf(docs, 'a').current.hotspots).toEqual([]);
  });

  it('moves a point by patching yaw (canonical) and pitch', () => {
    const docs = run(
      {
        type: 'point/add',
        panoId: 'a',
        hotspot: { id: 'p1', type: 'info', yaw: 0, pitch: 0, title: 'Fountain' },
      },
      { type: 'point/update', panoId: 'a', id: 'p1', patch: { yaw: 4, pitch: -0.3 } },
    );
    const moved = configOf(docs, 'a').current.hotspots[0]!;
    expect(moved.yaw).toBeCloseTo(4 - 2 * Math.PI);
    expect(moved.pitch).toBe(-0.3);
  });

  it('duplicates a point next to the original, offset round, with its content copied', () => {
    const original = {
      id: 'p1',
      type: 'info' as const,
      yaw: Math.PI - 0.05,
      pitch: 0.2,
      title: 'Fountain',
      body: '**Old**',
      icon: 'star',
      size: 2,
      media: { kind: 'youtube' as const, id: 'dQw4w9WgXcQ' },
    };
    const docs = run(
      { type: 'point/add', panoId: 'a', hotspot: original },
      {
        type: 'point/add',
        panoId: 'a',
        hotspot: { id: 'p2', type: 'info', yaw: 1, pitch: 0, title: 'Bench' },
      },
      { type: 'point/duplicate', panoId: 'a', id: 'p1', newId: 'p3' },
    );
    const hotspots = configOf(docs, 'a').current.hotspots;
    expect(hotspots.map((h) => h.id)).toEqual(['p1', 'p3', 'p2']);
    expect(hotspots[0]).toEqual(original);
    expect(hotspots[1]).toEqual({
      ...original,
      id: 'p3',
      title: 'Fountain (copy)',
      // Offset past π, so it wraps like every stored yaw.
      yaw: expect.closeTo(Math.PI + 0.05 - 2 * Math.PI),
    });
  });

  it('keeps a duplicate’s title within the limit', () => {
    const title = 'x'.repeat(MAX_TITLE_LENGTH);
    const docs = run(
      {
        type: 'point/add',
        panoId: 'a',
        hotspot: { id: 'p1', type: 'info', yaw: 0, pitch: 0, title },
      },
      { type: 'point/duplicate', panoId: 'a', id: 'p1', newId: 'p2' },
    );
    const copy = configOf(docs, 'a').current.hotspots[1]!;
    expect(copy.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(copy.title.endsWith(' (copy)')).toBe(true);
  });

  it('sizes a point from a placing drag: the marker radius in slider steps, clamped', () => {
    expect(pointSizeForDrag(17)).toBeNull();
    expect(pointSizeForDrag(34)).toBe(2);
    expect(pointSizeForDrag(25.5)).toBe(1.5);
    expect(pointSizeForDrag(1000)).toBe(3);
  });

  it('leaves the default size for a wobbly click or tap inside the marker', () => {
    for (const d of [0, 5, 8, 12, 16.9]) expect(pointSizeForDrag(d)).toBeNull();
  });

  it('removing the start scene clears startPanoId; start view and north are canonical', () => {
    const docs = run(
      { type: 'tour/remove-scene', panoId: 'b' },
      { type: 'scene/start-view', panoId: 'a', view: { yaw: -4, pitch: 0.2, fov: 60 } },
      { type: 'scene/north', panoId: 'a', north: 3.5 },
      { type: 'tour/settings', settings: { showMap: false } },
    );
    expect(docs.tour.current.scenes.map((s) => s.panoId)).toEqual(['a', 'gone', 'fresh']);
    expect(docs.tour.current).not.toHaveProperty('startPanoId');
    expect(docs.tour.current.settings).toEqual({
      controls: 'bottom',
      showMap: false,
      showCompass: true,
      autoRotate: false,
    });
    expect(configOf(docs, 'a').current.initialView?.yaw).toBeCloseTo(-4 + 2 * Math.PI);
    expect(configOf(docs, 'a').current.north).toBeCloseTo(3.5 - 2 * Math.PI);
  });

  it('sets the tour description trimmed, and an empty one removes it', () => {
    let docs = run({ type: 'tour/description', description: '  Old town\nat dusk  ' });
    expect(docs.tour.current.description).toBe('Old town\nat dusk');
    expect(dirtyKeys(docs)).toContain('tour');
    docs = editorReducer(docs, { type: 'tour/description', description: '   ' })!;
    expect(docs.tour.current).not.toHaveProperty('description');
    // Back to the loaded doc, so nothing is left to save.
    expect(dirtyKeys(docs)).not.toContain('tour');
  });

  it('loads a stored blank description as none, so clearing the field leaves nothing to save', () => {
    for (const description of ['', '  ']) {
      const loaded = fromServer({ ...server, tour: { ...server.tour, description } });
      expect(loaded.tour.base).not.toHaveProperty('description');
      expect(dirtyKeys(loaded)).toEqual([]);
      const touched = [
        { type: 'tour/description', description: 'x' },
        { type: 'tour/description', description: '' },
      ] as const;
      expect(dirtyKeys(touched.reduce<EditorDocs | null>(editorReducer, loaded)!)).toEqual([]);
    }
    const kept = fromServer({ ...server, tour: { ...server.tour, description: 'Old town' } });
    expect(kept.tour.base.description).toBe('Old town');
  });

  it('a save sets base to what was sent, so edits made meanwhile stay dirty', () => {
    const sent = run({ type: 'tour/title', title: 'Sent' }).tour.current;
    const docs = run(
      { type: 'tour/title', title: 'Sent' },
      { type: 'tour/title', title: 'Typed during save' },
      { type: 'saved', tour: { etag: 'te2', sent }, configs: {} },
    );
    expect(docs.tour.etag).toBe('te2');
    expect(dirtyKeys(docs)).toEqual(['tour']);
  });

  it('formats yaw as 0..359 degrees', () => {
    expect(yawDegrees(-Math.PI / 2)).toBe(270);
    expect(yawDegrees(normalizeAngle(Math.PI * 3))).toBe(180);
  });
});

describe('mergeAppendedScenes', () => {
  const base = { tourId: 't1', title: 'Old town', scenes: [{ panoId: 'a' }, { panoId: 'b' }] };

  it('takes the server copy as base and keeps local edits, appending the new scene', () => {
    const local = {
      etag: 'e1',
      base,
      current: { ...base, title: 'New name', scenes: [{ panoId: 'b' }] },
    };
    const tour = { ...base, scenes: [...base.scenes, { panoId: 'c' }] };
    expect(mergeAppendedScenes(local, { etag: 'e2', tour })).toEqual({
      etag: 'e2',
      base: tour,
      // A scene removed locally stays removed; the appended one is added once.
      current: { ...base, title: 'New name', scenes: [{ panoId: 'b' }, { panoId: 'c' }] },
    });
  });

  it('is null when the server tour changed in any other way', () => {
    const local = { etag: 'e1', base, current: base };
    const renamed = { ...base, title: 'Elsewhere', scenes: [...base.scenes, { panoId: 'c' }] };
    expect(mergeAppendedScenes(local, { etag: 'e2', tour: renamed })).toBeNull();
    const removed = { ...base, scenes: [{ panoId: 'a' }, { panoId: 'c' }] };
    expect(mergeAppendedScenes(local, { etag: 'e2', tour: removed })).toBeNull();
  });
});

describe('editor model: the floor plan', () => {
  const scenesOf = (docs: EditorDocs) => docs.tour.current.scenes;

  it('places, moves and removes a scene, in 0..1 plan fractions, as a tour edit', () => {
    let docs = run({ type: 'map/place', panoId: 'a', x: 0.25, y: 0.123456 });
    expect(scenesOf(docs)[0]).toEqual({ panoId: 'a', mapX: 0.25, mapY: 0.1235 });
    expect(dirtyKeys(docs)).toEqual(['tour']);
    docs = editorReducer(docs, { type: 'map/place', panoId: 'a', x: 1.4, y: -1 })!;
    expect(scenesOf(docs)[0]).toEqual({ panoId: 'a', mapX: 1, mapY: 0 });
    docs = editorReducer(docs, { type: 'map/remove', panoId: 'a' })!;
    expect(scenesOf(docs)[0]).toEqual({ panoId: 'a' });
    // Back where it was loaded: no edit left.
    expect(dirtyKeys(docs)).toEqual([]);
  });

  it('converts older, unit-free positions where they were drawn before placing another', () => {
    const legacy = {
      ...server,
      tour: {
        ...server.tour,
        scenes: [
          { panoId: 'a', mapX: 10, mapY: 0 },
          { panoId: 'b', mapX: 30, mapY: 20 },
          { panoId: 'gone' },
        ],
      },
    };
    const docs = editorReducer(fromServer(legacy), {
      type: 'map/place',
      panoId: 'gone',
      x: 0.5,
      y: 0.5,
    })!;
    expect(scenesOf(docs)).toEqual([
      { panoId: 'a', mapX: 0.08, mapY: 0.08 },
      { panoId: 'b', mapX: 0.92, mapY: 0.92 },
      { panoId: 'gone', mapX: 0.5, mapY: 0.5 },
    ]);
  });

  it('sets and removes the plan image', () => {
    const plan = { id: 'pl1', type: 'image/webp' as const, width: 800, height: 600 };
    let docs = run({ type: 'tour/plan', plan });
    expect(docs.tour.current.plan).toEqual(plan);
    docs = editorReducer(docs, { type: 'tour/plan', plan: null })!;
    expect(docs.tour.current).not.toHaveProperty('plan');
    expect(dirtyKeys(docs)).toEqual([]);
  });
});
