import type { TourWithConfigsOk } from '@internal/contracts';
import { ApiError, AuthRequiredError, ConflictError } from '@internal/web-kit';
import { describe, expect, it, vi } from 'vitest';

import { editorReducer, fromServer, type EditorAction, type EditorDocs } from './model.js';
import { planSave, runPublish, runSave, type SaveApi } from './save.js';

const server: TourWithConfigsOk = {
  tour: {
    tourId: 't1',
    title: 'Old town',
    scenes: [{ panoId: 'a' }, { panoId: 'b' }, { panoId: 'new' }],
  },
  etag: 'te',
  configs: {
    a: { config: { panoId: 'a', title: 'Square', hotspots: [] }, etag: 'ea' },
    b: { config: { panoId: 'b', title: 'Church', hotspots: [] }, etag: 'eb' },
    new: { missing: true, deleting: false, hasOriginal: true },
  },
};

const docsAfter = (...actions: EditorAction[]): EditorDocs =>
  actions.reduce<EditorDocs | null>(editorReducer, fromServer(server))!;

const fakeApi = (over: Partial<SaveApi> = {}): SaveApi => ({
  putTour: vi.fn(async () => ({ etag: 'te2' })),
  putPanoConfig: vi.fn(async (panoId: string) => ({ etag: `${panoId}-2` })),
  createPanoConfig: vi.fn(async (panoId: string) => ({ etag: `${panoId}-1` })),
  publishTour: vi.fn(async () => ({
    slug: 'old-town',
    visibility: 'unlisted' as const,
    url: '/s/old-town',
    publishedAt: '2026-10-01T00:00:00Z',
  })),
  ...over,
});

describe('runSave', () => {
  it('sends one PUT per dirty doc with its own If-Match, and nothing for clean docs', async () => {
    const api = fakeApi();
    const docs = docsAfter(
      { type: 'scene/title', panoId: 'a', title: 'Plaza' },
      { type: 'scene/title', panoId: 'new', title: 'Cellar' },
      { type: 'tour/title', title: 'Old town 2' },
    );
    const out = await runSave(api, 't1', planSave(docs));
    expect(api.putPanoConfig).toHaveBeenCalledTimes(1);
    expect(api.putPanoConfig).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ title: 'Plaza' }),
      'ea',
    );
    // An untitled original has no config yet: created create-only, never with If-Match: *.
    expect(api.createPanoConfig).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({ title: 'Cellar' }),
    );
    expect(api.putPanoConfig).not.toHaveBeenCalledWith('new', expect.anything(), '*');
    expect(api.putTour).toHaveBeenCalledTimes(1);
    expect(api.putTour).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ title: 'Old town 2' }),
      'te',
    );
    expect(out.failures).toEqual({});
    expect(out.tour?.etag).toBe('te2');
    expect(Object.keys(out.configs).sort()).toEqual(['a', 'new']);
  });

  it('reports a 412 per document and still saves the others', async () => {
    const api = fakeApi({
      putPanoConfig: vi.fn(async () => {
        throw new ConflictError({ error: 'conflict' });
      }),
    });
    const docs = docsAfter(
      { type: 'scene/title', panoId: 'b', title: 'Chapel' },
      { type: 'tour/title', title: 'Renamed' },
    );
    const out = await runSave(api, 't1', planSave(docs));
    expect(out.failures).toEqual({ 'pano:b': { kind: 'conflict' } });
    expect(out.tour?.etag).toBe('te2');
  });

  it('maps auth, deleted and generic errors, and never PUTs an invalid doc', async () => {
    const api = fakeApi({
      putTour: vi.fn(async () => {
        throw new AuthRequiredError('401');
      }),
      putPanoConfig: vi.fn(async () => {
        throw new ApiError(409, { error: 'pano is being deleted' });
      }),
    });
    const docs = docsAfter(
      { type: 'scene/title', panoId: 'a', title: 'x' },
      { type: 'tour/title', title: 'T' },
    );
    const out = await runSave(api, 't1', planSave(docs));
    expect(out.failures.tour).toEqual({ kind: 'auth' });
    expect(out.failures['pano:a']).toMatchObject({ kind: 'error', status: 409 });

    const bad = docsAfter({ type: 'tour/title', title: '' });
    const res = await runSave(fakeApi(), 't1', planSave(bad));
    expect(res.failures.tour).toMatchObject({ kind: 'invalid' });
  });
});

describe('runPublish', () => {
  it('turns publish failures into outcomes instead of throwing', async () => {
    const lost = fakeApi({
      publishTour: vi.fn(async () => {
        throw new ApiError(409, { error: 'slug lost' });
      }),
    });
    await expect(runPublish(lost, 't1')).resolves.toEqual({ kind: 'slug-lost' });

    const scenes = [{ panoId: 'a', reason: 'not-ready' }];
    const notReady = fakeApi({
      publishTour: vi.fn(async () => {
        throw new ApiError(422, { error: 'scenes not publishable', scenes });
      }),
    });
    await expect(runPublish(notReady, 't1')).resolves.toEqual({ kind: 'unpublishable', scenes });

    const down = fakeApi({
      publishTour: vi.fn(async () => {
        throw new ApiError(503, { error: 'busy' });
      }),
    });
    await expect(runPublish(down, 't1')).resolves.toMatchObject({ kind: 'failed' });
    await expect(runPublish(fakeApi(), 't1')).resolves.toMatchObject({ kind: 'ok' });
  });
});
