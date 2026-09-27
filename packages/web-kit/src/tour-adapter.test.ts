import {
  PublishedTourSchema,
  SceneConfigSchema,
  TourDocSchema,
  type SceneConfig,
} from '@internal/contracts';
import { describe, expect, it } from 'vitest';

import { DEFAULT_TOUR_SETTINGS, publishedToViewerTour, toViewerTour } from './tour-adapter.js';

// Parse through the contract schemas, exactly as API responses are.
const scene = (raw: Record<string, unknown>): SceneConfig => SceneConfigSchema.parse(raw);
const tour = (raw: Record<string, unknown>) =>
  TourDocSchema.parse({ tourId: 't1', title: 'T', ...raw });

const hall = scene({
  panoId: 'hall',
  title: 'Hall',
  initialView: { yaw: 1, pitch: 0.1, fov: 60 },
  north: 0.5,
  hotspots: [
    {
      id: 'i1',
      type: 'info',
      yaw: 0.2,
      pitch: 0.3,
      title: 'Clock',
      body: '**old**',
      icon: 'clock',
      size: 1.5,
      media: { kind: 'youtube', id: 'dQw4w9WgXcQ' },
    },
    { id: 'l1', type: 'link', yaw: 2, pitch: -0.4, title: 'To nave', targetPanoId: 'nave' },
    { id: 'l2', type: 'link', yaw: -2, pitch: -0.4, title: 'To crypt', targetPanoId: 'crypt' },
  ],
});
const nave = scene({
  panoId: 'nave',
  title: 'Nave',
  hotspots: [
    { id: 'l3', type: 'link', yaw: -1, pitch: -0.4, title: 'Back', targetPanoId: 'hall' },
    { id: 'l4', type: 'link', yaw: 0, pitch: 0, title: 'Self', targetPanoId: 'nave' },
  ],
});

describe('toViewerTour', () => {
  it('turns link hotspots into viewer links and info hotspots into InfoHotspotData', () => {
    const doc = tour({
      scenes: [{ panoId: 'hall', mapX: 0.2, mapY: 0.4 }, { panoId: 'nave' }],
    });
    const v = toViewerTour(doc, { hall, nave });
    expect(v.tour).toEqual({
      start: 'hall',
      scenes: {
        hall: {
          initialView: { yaw: 1, pitch: 0.1, fov: 60 },
          links: [{ to: 'nave', yaw: 2, label: 'To nave', source: hall.hotspots[1] }],
        },
        nave: { links: [{ to: 'hall', yaw: -1, label: 'Back', source: nave.hotspots[0] }] },
      },
    });
    expect(v.hotspots.hall).toEqual([
      {
        id: 'i1',
        yaw: 0.2,
        pitch: 0.3,
        title: 'Clock',
        body: '**old**',
        source: hall.hotspots[0],
      },
    ]);
    // The full stored hotspot rides along for the React chrome (icon, size, media).
    expect(v.hotspots.hall?.[0]?.source).toMatchObject({
      icon: 'clock',
      size: 1.5,
      media: { kind: 'youtube', id: 'dQw4w9WgXcQ' },
    });
    expect(v.links.hall).toBe(v.tour?.scenes.hall?.links);
    expect(v.links.nave?.[0]?.source.id).toBe('l3');
    expect(v.hotspots.nave).toEqual([]);
    expect(v.north).toEqual({ hall: 0.5, nave: 0 });
    expect(v.titles).toEqual({ hall: 'Hall', nave: 'Nave' });
    expect(v.mapPositions).toEqual({ hall: { x: 0.2, y: 0.4 } });
    expect(v.missing).toEqual([]);
    expect(v.settings).toEqual(DEFAULT_TOUR_SETTINGS);
  });

  it('drops links to scenes outside the tour and self-links', () => {
    const v = toViewerTour(tour({ scenes: [{ panoId: 'hall' }, { panoId: 'nave' }] }), {
      hall,
      nave,
    });
    expect(v.tour?.scenes.hall?.links.map((l) => l.to)).toEqual(['nave']);
    expect(v.tour?.scenes.nave?.links.map((l) => l.to)).toEqual(['hall']);
  });

  it('honours startPanoId, falling back to the first loaded scene', () => {
    const docs = [
      [tour({ scenes: [{ panoId: 'hall' }, { panoId: 'nave' }], startPanoId: 'nave' }), 'nave'],
      [tour({ scenes: [{ panoId: 'hall' }, { panoId: 'nave' }], startPanoId: 'gone' }), 'hall'],
      [tour({ scenes: [{ panoId: 'crypt' }, { panoId: 'nave' }] }), 'nave'],
    ] as const;
    for (const [doc, start] of docs) {
      expect(toViewerTour(doc, { hall, nave }).tour?.start).toBe(start);
    }
  });

  it('accepts admin ?include=configs entries and reports missing scenes', () => {
    const doc = tour({ scenes: [{ panoId: 'hall' }, { panoId: 'crypt' }, { panoId: 'nave' }] });
    const v = toViewerTour(doc, {
      hall: { config: hall, etag: 'e1' },
      crypt: { missing: true, deleting: false, hasOriginal: true },
      nave: { config: nave, etag: 'e2' },
    });
    expect(v.missing).toEqual(['crypt']);
    expect(Object.keys(v.tour?.scenes ?? {})).toEqual(['hall', 'nave']);
    expect(v.tour?.scenes.hall?.links.map((l) => l.to)).toEqual(['nave']);
  });

  it('ignores a config whose panoId does not match its scene, and duplicate scenes', () => {
    const doc = tour({ scenes: [{ panoId: 'hall' }, { panoId: 'hall' }, { panoId: 'nave' }] });
    const v = toViewerTour(doc, { hall: nave, nave });
    expect(v.missing).toEqual(['hall']);
    expect(v.tour?.start).toBe('nave');
    expect(v.tour?.scenes.nave?.links).toEqual([]);
  });

  it('returns a null tour when nothing is loadable', () => {
    const v = toViewerTour(tour({ scenes: [{ panoId: 'hall' }] }), {});
    expect(v.tour).toBeNull();
    expect(v.missing).toEqual(['hall']);
    expect(toViewerTour(tour({}), {}).tour).toBeNull();
  });

  it('passes saved tour settings through', () => {
    const settings = {
      controls: 'top',
      showMap: false,
      showCompass: true,
      autoRotate: true,
    } as const;
    expect(toViewerTour(tour({ settings }), {}).settings).toEqual(settings);
  });

  it('receives canonical angles because configs are schema-parsed', () => {
    const wild = scene({
      panoId: 'hall',
      title: 'Hall',
      initialView: { yaw: 9, pitch: 3, fov: 5 },
      hotspots: [{ id: 'i', type: 'info', yaw: -9, pitch: -3, title: 'x' }],
    });
    const v = toViewerTour(tour({ scenes: [{ panoId: 'hall' }] }), { hall: wild });
    expect(v.tour?.scenes.hall?.initialView).toEqual({
      yaw: 9 - 2 * Math.PI,
      pitch: Math.PI / 2,
      fov: 15,
    });
    expect(v.hotspots.hall?.[0]?.yaw).toBeCloseTo(-9 + 2 * Math.PI);
    expect(v.hotspots.hall?.[0]?.pitch).toBe(-Math.PI / 2);
  });

  it('labels a link with the hotspot title, falling back to the target scene title', () => {
    const untitled = { ...hall, hotspots: [{ ...hall.hotspots[1]!, title: '' }] };
    const v = toViewerTour(tour({ scenes: [{ panoId: 'hall' }, { panoId: 'nave' }] }), {
      hall: untitled,
      nave,
    });
    expect(v.links.hall?.[0]?.label).toBe('Nave');
  });
});

describe('publishedToViewerTour', () => {
  it('adapts a pub bundle: start scene, links, map positions and settings', () => {
    const settings = { controls: 'top', showMap: false, showCompass: true, autoRotate: true };
    const pub = PublishedTourSchema.parse({
      v: 1,
      tourId: 't1',
      title: 'T',
      visibility: 'public',
      slug: 'tee',
      publishedAt: '2026-09-20T00:00:00Z',
      settings,
      startPanoId: 'nave',
      scenes: [
        { panoId: 'hall', mapX: 1, mapY: 2, config: hall },
        { panoId: 'nave', config: nave },
      ],
    });
    const vt = publishedToViewerTour(pub);
    expect(vt.tour?.start).toBe('nave');
    expect(vt.links.hall?.map((l) => l.to)).toEqual(['nave']);
    expect(vt.hotspots.hall?.[0]?.source.media).toEqual({ kind: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(vt.mapPositions).toEqual({ hall: { x: 1, y: 2 } });
    expect(vt.settings).toEqual(settings);
    expect(vt.missing).toEqual([]);
  });
});
