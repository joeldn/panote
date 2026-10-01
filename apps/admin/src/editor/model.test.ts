import type { TourWithConfigsOk } from '@internal/contracts';
import { describe, expect, it } from 'vitest';

import {
  dirtyKeys,
  editorReducer,
  findLink,
  fromServer,
  normalizeAngle,
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
