import type { PanoViewer, PreviewSource, ViewerOptions } from '@panote/viewer';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PanoStage, type StagePreview } from './PanoStage.js';
import { useStageEvents } from './stage-events.js';
import { usePanoViewer } from './viewer-context.js';

type Handler = (payload: unknown) => void;

class FakeViewer {
  handlers = new Map<string, Set<Handler>>();
  load = vi.fn(async (_pano: string, _opts?: unknown) => true);
  transitionTo = vi.fn(async (_pano: string, _view?: unknown) => {});
  showPreview = vi.fn((_pano: string, _source: PreviewSource, _opts?: unknown) => {});
  /** Viewer calls in order, to check that the preview goes up before the load. */
  calls: string[] = [];
  setView = vi.fn();
  setNorth = vi.fn();
  setAutoRotate = vi.fn();
  dispose = vi.fn();
  constructor(
    readonly container: HTMLElement,
    readonly options: ViewerOptions,
  ) {
    this.load.mockImplementation(async (pano) => {
      this.calls.push(`load:${pano}`);
      return true;
    });
    this.showPreview.mockImplementation((pano) => {
      this.calls.push(`show:${pano}`);
    });
    this.setView.mockImplementation(() => {
      this.calls.push('setView');
    });
  }
  on = (type: string, fn: Handler) => {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)?.add(fn);
  };
  off = (type: string, fn: Handler) => this.handlers.get(type)?.delete(fn);
  emit(type: string, payload?: unknown) {
    this.handlers.get(type)?.forEach((fn) => fn(payload));
  }
}

function factory() {
  const made: FakeViewer[] = [];
  const createViewer = vi.fn((el: HTMLElement, opts: ViewerOptions) => {
    const v = new FakeViewer(el, opts);
    made.push(v);
    return v as unknown as PanoViewer;
  });
  const last = () => {
    const v = made[made.length - 1];
    if (!v) throw new Error('no viewer created');
    return v;
  };
  return { createViewer, made, last };
}

function fakeSource(): PreviewSource {
  return { width: 8, height: 4, patches: [] };
}

/** A preview whose factory hands out a new source on each call. */
function previewOf(panoId: string, extra: Partial<StagePreview> = {}) {
  const sources: PreviewSource[] = [];
  const source = vi.fn(() => {
    const s = fakeSource();
    sources.push(s);
    return s;
  });
  const preview: StagePreview = { panoId, key: 'job-1', source, ...extra };
  return { preview, source, sources };
}

/** A source whose one patch records `close()`. */
function closableSource() {
  const close = vi.fn();
  const source: PreviewSource = {
    width: 8,
    height: 4,
    patches: [{ x: 0, y: 0, w: 8, h: 4, image: { close } as unknown as ImageBitmap }],
  };
  return { source, close };
}

/** A preview whose factory returns a promise the test settles. */
function asyncPreviewOf(panoId: string, key = 'job-1') {
  const pending: { resolve: (s: PreviewSource) => void; reject: (e: unknown) => void }[] = [];
  const source = vi.fn(
    () =>
      new Promise<PreviewSource>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  const preview: StagePreview = { panoId, key, source };
  return { preview, source, pending };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Run the viewer's resolver for `id`, and check which manifest URL it fetched. */
async function resolvedUrl(options: ViewerOptions, id: string, url: string) {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(options.resolveSource!(id, new AbortController().signal)).rejects.toThrow(
    'manifest 404',
  );
  expect(fetchMock).toHaveBeenCalledWith(url, expect.anything());
}

describe('PanoStage', () => {
  it('creates one viewer in its host with the initial view, north and auto-rotate, then loads', () => {
    const f = factory();
    render(
      <PanoStage
        baseUrl="https://cdn.test/tiles/"
        panoId="hall"
        view={{ yaw: 1, fov: 60 }}
        north={0.5}
        autoRotate
        options={{ maxFov: 90 }}
        createViewer={f.createViewer}
      />,
    );
    expect(f.createViewer).toHaveBeenCalledTimes(1);
    const v = f.last();
    expect(v.container.className).toBe('pn-stage__viewer');
    expect(v.options).toEqual({
      maxFov: 90,
      resolveSource: expect.any(Function),
      requestInit: { mode: 'cors', credentials: 'same-origin' },
      autoRotate: true,
      initialView: { yaw: 1, fov: 60 },
      north: 0.5,
    });
    expect(v.load).toHaveBeenCalledWith('hall', { view: { yaw: 1, fov: 60 } });
    expect(v.setNorth).toHaveBeenLastCalledWith(0.5);
    expect(v.setAutoRotate).toHaveBeenLastCalledWith(true);
  });

  it('applies the scene view and loads on pano change; crossfades when transition is on', () => {
    const f = factory();
    const { rerender } = render(
      <PanoStage baseUrl="b/" panoId="hall" createViewer={f.createViewer} />,
    );
    const v = f.last();
    rerender(
      <PanoStage baseUrl="b/" panoId="nave" view={{ yaw: 2 }} createViewer={f.createViewer} />,
    );
    expect(v.load).toHaveBeenLastCalledWith('nave', { view: { yaw: 2 } });
    expect(v.setView).not.toHaveBeenCalled();
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="crypt"
        view={{ yaw: 3 }}
        transition
        createViewer={f.createViewer}
      />,
    );
    expect(v.transitionTo).toHaveBeenCalledWith('crypt', { yaw: 3 });
    expect(v.load).toHaveBeenCalledTimes(2);
    expect(f.createViewer).toHaveBeenCalledTimes(1);
  });

  it('does not load while panoId is null, and updates north/auto-rotate in place', () => {
    const f = factory();
    const { rerender } = render(
      <PanoStage baseUrl="b/" panoId={null} createViewer={f.createViewer} />,
    );
    const v = f.last();
    expect(v.load).not.toHaveBeenCalled();
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId={null}
        north={1.25}
        autoRotate
        createViewer={f.createViewer}
      />,
    );
    expect(v.setNorth).toHaveBeenLastCalledWith(1.25);
    expect(v.setAutoRotate).toHaveBeenLastCalledWith(true);
  });

  it('reports load failures for the current pano only', async () => {
    const f = factory();
    const onLoadError = vi.fn();
    const { rerender } = render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        onLoadError={onLoadError}
        createViewer={f.createViewer}
      />,
    );
    const v = f.last();
    let failNave!: (e: Error) => void;
    v.load.mockImplementationOnce(
      () =>
        new Promise<boolean>((_r, rej) => {
          failNave = rej;
        }),
    );
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="nave"
        onLoadError={onLoadError}
        createViewer={f.createViewer}
      />,
    );
    v.load.mockRejectedValueOnce(new Error('manifest 404'));
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="gone"
        onLoadError={onLoadError}
        createViewer={f.createViewer}
      />,
    );
    await act(async () => failNave(new Error('superseded')));
    expect(onLoadError).toHaveBeenCalledTimes(1);
    expect(onLoadError).toHaveBeenCalledWith(new Error('manifest 404'), 'gone');
  });

  it('forwards scene-change and chrome hotspot opens, and exposes the viewer to children', () => {
    const f = factory();
    const onSceneChange = vi.fn();
    const onHotspotOpen = vi.fn();
    const onViewer = vi.fn();
    function Chrome() {
      const viewer = usePanoViewer();
      const events = useStageEvents();
      return (
        <button type="button" onClick={() => events.hotspotOpen('h1')}>
          {viewer ? 'chrome:ready' : 'chrome:none'}
        </button>
      );
    }
    const { unmount } = render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        onSceneChange={onSceneChange}
        onHotspotOpen={onHotspotOpen}
        onViewer={onViewer}
        createViewer={f.createViewer}
      >
        <Chrome />
      </PanoStage>,
    );
    const v = f.last();
    expect(screen.getByText('chrome:ready')).toBeTruthy();
    expect(onViewer).toHaveBeenLastCalledWith(v);
    v.emit('scene-change', 'hall');
    fireEvent.click(screen.getByText('chrome:ready'));
    expect(onSceneChange).toHaveBeenCalledWith('hall');
    expect(onHotspotOpen).toHaveBeenCalledExactlyOnceWith('h1');
    // Analytics no longer pass through the viewer.
    expect(v.handlers.has('hotspot-open')).toBe(false);
    unmount();
    expect(v.dispose).toHaveBeenCalledTimes(1);
    expect(v.handlers.get('scene-change')?.size).toBe(0);
    expect(onViewer).toHaveBeenLastCalledWith(null);
  });

  it('recreates the viewer when baseUrl changes', async () => {
    const f = factory();
    const { rerender } = render(
      <PanoStage baseUrl="a/" panoId="hall" createViewer={f.createViewer} />,
    );
    const first = f.last();
    rerender(<PanoStage baseUrl="b/" panoId="hall" createViewer={f.createViewer} />);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(f.made).toHaveLength(2);
    // The new viewer resolves against the new base.
    await resolvedUrl(f.last().options, 'hall', 'b/hall/manifest.json');
    expect(f.last().load).toHaveBeenCalledWith('hall');
  });

  it('survives StrictMode double-mount with exactly one live viewer', () => {
    const f = factory();
    render(
      <StrictMode>
        <PanoStage baseUrl="b/" panoId="hall" createViewer={f.createViewer} />
      </StrictMode>,
    );
    const live = f.made.filter((v) => v.dispose.mock.calls.length === 0);
    expect(live).toHaveLength(1);
    expect(live[0]?.load).toHaveBeenCalledWith('hall');
  });

  it('reloads the same pano when reloadKey changes (replace-image finished)', () => {
    const f = factory();
    const { rerender } = render(
      <PanoStage baseUrl="b/" panoId="hall" reloadKey="t1-old" createViewer={f.createViewer} />,
    );
    const v = f.last();
    expect(v.load).toHaveBeenCalledTimes(1);
    rerender(
      <PanoStage baseUrl="b/" panoId="hall" reloadKey="t1-old" createViewer={f.createViewer} />,
    );
    expect(v.load).toHaveBeenCalledTimes(1);
    rerender(
      <PanoStage baseUrl="b/" panoId="hall" reloadKey="t1-new" createViewer={f.createViewer} />,
    );
    expect(v.load).toHaveBeenCalledTimes(2);
    expect(v.load).toHaveBeenLastCalledWith('hall');
    expect(f.createViewer).toHaveBeenCalledTimes(1);
  });

  it('keeps the camera on a reloadKey reload and applies the scene view on a pano change', () => {
    const f = factory();
    const { rerender } = render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        view={{ yaw: 1 }}
        reloadKey="v1"
        createViewer={f.createViewer}
      />,
    );
    const v = f.last();
    // The view rides on the load, so the outgoing scene never swings to it.
    expect(v.calls).toEqual(['load:hall']);
    expect(v.load).toHaveBeenLastCalledWith('hall', { view: { yaw: 1 } });
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        view={{ yaw: 1 }}
        reloadKey="v2"
        createViewer={f.createViewer}
      />,
    );
    expect(v.calls).toEqual(['load:hall', 'load:hall']);
    expect(v.load).toHaveBeenLastCalledWith('hall');
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="nave"
        view={{ yaw: 2 }}
        reloadKey="v2"
        createViewer={f.createViewer}
      />,
    );
    expect(v.load).toHaveBeenLastCalledWith('nave', { view: { yaw: 2 } });
    expect(v.setView).not.toHaveBeenCalled();
  });

  it('reloads with a plain load, not a crossfade, when transition is on', () => {
    const f = factory();
    const { rerender } = render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        reloadKey={1}
        transition
        createViewer={f.createViewer}
      />,
    );
    const v = f.last();
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        reloadKey={2}
        transition
        createViewer={f.createViewer}
      />,
    );
    expect(v.transitionTo).not.toHaveBeenCalled();
    expect(v.load).toHaveBeenCalledTimes(2);
    expect(v.setView).not.toHaveBeenCalled();
  });

  it('shows the preview, then loads the pano', () => {
    const f = factory();
    const { preview, source, sources } = previewOf('hall', { replacesVersion: 'v1' });
    render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        view={{ yaw: 1 }}
        preview={preview}
        createViewer={f.createViewer}
      />,
    );
    const v = f.last();
    expect(source).toHaveBeenCalledTimes(1);
    expect(v.calls).toEqual(['setView', 'show:hall', 'load:hall']);
    expect(v.showPreview).toHaveBeenCalledWith('hall', sources[0], { replacesVersion: 'v1' });
  });

  it('waits for an async source before showing it and loading', async () => {
    const f = factory();
    const { preview, pending } = asyncPreviewOf('hall');
    render(
      <PanoStage baseUrl="b/" panoId="hall" preview={preview} createViewer={f.createViewer} />,
    );
    const v = f.last();
    expect(v.calls).toEqual([]);
    const s = fakeSource();
    await act(async () => pending[0]?.resolve(s));
    expect(v.calls).toEqual(['show:hall', 'load:hall']);
    expect(v.showPreview).toHaveBeenCalledWith('hall', s, {});
  });

  it('aims the camera only as an async preview goes up, and keeps the scene view if it never does', async () => {
    const f = factory();
    const { preview, pending } = asyncPreviewOf('hall');
    const { rerender } = render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        view={{ yaw: 1 }}
        preview={preview}
        createViewer={f.createViewer}
      />,
    );
    const v = f.last();
    // Nothing moves while the source is still decoding.
    expect(v.calls).toEqual([]);
    await act(async () => pending[0]?.resolve(fakeSource()));
    expect(v.calls).toEqual(['setView', 'show:hall', 'load:hall']);
    expect(v.setView).toHaveBeenCalledWith({ yaw: 1 });

    // A new pano whose preview fails: the tiles still arrive at its view.
    const failing = asyncPreviewOf('nave', 'job-2');
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="nave"
        view={{ yaw: 2 }}
        preview={failing.preview}
        onPreviewError={() => {}}
        createViewer={f.createViewer}
      />,
    );
    await act(async () => failing.pending[0]?.reject(new Error('stash gone')));
    expect(v.setView).toHaveBeenCalledTimes(1);
    expect(v.load).toHaveBeenLastCalledWith('nave', { view: { yaw: 2 } });
  });

  it('ignores a preview for another pano', () => {
    const f = factory();
    const { preview, source } = previewOf('nave');
    render(
      <PanoStage baseUrl="b/" panoId="hall" preview={preview} createViewer={f.createViewer} />,
    );
    expect(source).not.toHaveBeenCalled();
    expect(f.last().calls).toEqual(['load:hall']);
  });

  it('shows a preview once: a reload, a rebuilt object with the same key or a dropped preview do not show it again', () => {
    const f = factory();
    const { preview, source } = previewOf('hall');
    const { rerender } = render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        reloadKey="old"
        preview={preview}
        createViewer={f.createViewer}
      />,
    );
    const v = f.last();
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        reloadKey="new"
        preview={preview}
        createViewer={f.createViewer}
      />,
    );
    // Rebuilt on every render (e.g. a status poll): same key, so nothing happens.
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        reloadKey="new"
        preview={{ ...preview }}
        createViewer={f.createViewer}
      />,
    );
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        reloadKey="new"
        preview={null}
        createViewer={f.createViewer}
      />,
    );
    expect(source).toHaveBeenCalledTimes(1);
    expect(v.calls).toEqual(['show:hall', 'load:hall', 'load:hall']);
  });

  it('swaps in a preview with a new key for the pano on stage without moving the camera', () => {
    const f = factory();
    const first = previewOf('hall');
    const { rerender } = render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        view={{ yaw: 1 }}
        preview={first.preview}
        createViewer={f.createViewer}
      />,
    );
    const v = f.last();
    const second = previewOf('hall', { key: 'job-2', replacesVersion: 'v2' });
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        view={{ yaw: 1 }}
        preview={second.preview}
        createViewer={f.createViewer}
      />,
    );
    expect(v.calls).toEqual(['setView', 'show:hall', 'load:hall', 'show:hall', 'load:hall']);
    expect(v.showPreview).toHaveBeenLastCalledWith('hall', second.sources[0], {
      replacesVersion: 'v2',
    });
  });

  it('builds a fresh source for a new viewer', () => {
    const f = factory();
    const { preview, source, sources } = previewOf('hall');
    const { rerender } = render(
      <PanoStage baseUrl="a/" panoId="hall" preview={preview} createViewer={f.createViewer} />,
    );
    rerender(
      <PanoStage baseUrl="b/" panoId="hall" preview={preview} createViewer={f.createViewer} />,
    );
    expect(f.made).toHaveLength(2);
    expect(source).toHaveBeenCalledTimes(2);
    expect(sources[0]).not.toBe(sources[1]);
    expect(f.made[0]?.showPreview).toHaveBeenCalledWith('hall', sources[0], {});
    expect(f.last().showPreview).toHaveBeenCalledWith('hall', sources[1], {});
  });

  it('never shows a source twice under StrictMode', () => {
    const f = factory();
    const { preview, sources } = previewOf('hall');
    const { rerender } = render(
      <StrictMode>
        <PanoStage
          baseUrl="b/"
          panoId="hall"
          reloadKey={1}
          preview={preview}
          createViewer={f.createViewer}
        />
      </StrictMode>,
    );
    rerender(
      <StrictMode>
        <PanoStage
          baseUrl="b/"
          panoId="hall"
          reloadKey={2}
          preview={preview}
          createViewer={f.createViewer}
        />
      </StrictMode>,
    );
    const shownSources = f.made.flatMap((v) => v.showPreview.mock.calls.map((c) => c[1]));
    expect(new Set(shownSources).size).toBe(shownSources.length);
    const live = f.made.filter((v) => v.dispose.mock.calls.length === 0);
    expect(live).toHaveLength(1);
    expect(live[0]?.showPreview).toHaveBeenCalledTimes(1);
    expect(live[0]?.showPreview).toHaveBeenCalledWith('hall', sources[sources.length - 1], {});
    expect(live[0]?.calls.at(-1)).toBe('load:hall');
  });

  it('closes an async source that lands after the stage moved to another pano', async () => {
    const f = factory();
    const { preview, pending } = asyncPreviewOf('hall');
    const { rerender } = render(
      <PanoStage baseUrl="b/" panoId="hall" preview={preview} createViewer={f.createViewer} />,
    );
    const v = f.last();
    rerender(
      <PanoStage baseUrl="b/" panoId="nave" preview={preview} createViewer={f.createViewer} />,
    );
    const { source, close } = closableSource();
    await act(async () => pending[0]?.resolve(source));
    expect(close).toHaveBeenCalledTimes(1);
    expect(v.showPreview).not.toHaveBeenCalled();
    expect(v.calls).toEqual(['load:nave']);
  });

  it('asks for a fresh source when reloadKey changes while one is pending', async () => {
    const f = factory();
    const { preview, source, pending } = asyncPreviewOf('hall');
    const { rerender } = render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        reloadKey={1}
        preview={preview}
        createViewer={f.createViewer}
      />,
    );
    const v = f.last();
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        reloadKey={2}
        preview={preview}
        createViewer={f.createViewer}
      />,
    );
    expect(source).toHaveBeenCalledTimes(2);
    const stale = closableSource();
    const fresh = fakeSource();
    await act(async () => {
      pending[0]?.resolve(stale.source);
      pending[1]?.resolve(fresh);
    });
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(v.showPreview).toHaveBeenCalledTimes(1);
    expect(v.showPreview).toHaveBeenCalledWith('hall', fresh, {});
    expect(v.calls).toEqual(['show:hall', 'load:hall']);
  });

  it('closes a pending source when the stage unmounts', async () => {
    const f = factory();
    const { preview, pending } = asyncPreviewOf('hall');
    const { unmount } = render(
      <PanoStage baseUrl="b/" panoId="hall" preview={preview} createViewer={f.createViewer} />,
    );
    const v = f.last();
    unmount();
    const { source, close } = closableSource();
    await act(async () => pending[0]?.resolve(source));
    expect(close).toHaveBeenCalledTimes(1);
    expect(v.showPreview).not.toHaveBeenCalled();
    expect(v.load).not.toHaveBeenCalled();
  });

  it('reports a throwing or rejecting source to onPreviewError only, and still loads', async () => {
    const f = factory();
    const onLoadError = vi.fn();
    const onPreviewError = vi.fn();
    const boom = new Error('decode failed');
    const throwing: StagePreview = {
      panoId: 'hall',
      key: 'job-1',
      source: () => {
        throw boom;
      },
    };
    const { rerender } = render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        preview={throwing}
        onLoadError={onLoadError}
        onPreviewError={onPreviewError}
        createViewer={f.createViewer}
      />,
    );
    const v = f.last();
    expect(onPreviewError).toHaveBeenCalledWith(boom, 'hall');
    expect(v.calls).toEqual(['load:hall']);

    const rejecting = asyncPreviewOf('hall', 'job-2');
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        preview={rejecting.preview}
        onLoadError={onLoadError}
        onPreviewError={onPreviewError}
        createViewer={f.createViewer}
      />,
    );
    const nope = new Error('stash gone');
    await act(async () => rejecting.pending[0]?.reject(nope));
    expect(onPreviewError).toHaveBeenLastCalledWith(nope, 'hall');
    expect(onPreviewError).toHaveBeenCalledTimes(2);
    expect(v.calls).toEqual(['load:hall', 'load:hall']);
    expect(v.showPreview).not.toHaveBeenCalled();
    expect(onLoadError).not.toHaveBeenCalled();
  });

  it('survives showPreview throwing for a sync source: reports it, closes the source, loads', () => {
    const f = factory();
    const onLoadError = vi.fn();
    const onPreviewError = vi.fn();
    const { source, close } = closableSource();
    const preview: StagePreview = { panoId: 'hall', key: 'job-1', source: () => source };
    const refused = new RangeError('preview source has no patches');
    const createViewer = vi.fn((el: HTMLElement, opts: ViewerOptions) => {
      const viewer = f.createViewer(el, opts);
      f.last().showPreview.mockImplementation(() => {
        throw refused;
      });
      return viewer;
    });
    render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        preview={preview}
        onLoadError={onLoadError}
        onPreviewError={onPreviewError}
        createViewer={createViewer}
      />,
    );
    expect(screen.getByRole('application')).toBeTruthy();
    expect(onPreviewError).toHaveBeenCalledWith(refused, 'hall');
    expect(onLoadError).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(f.last().calls).toEqual(['load:hall']);
  });

  it('survives showPreview throwing for an async source: reports it and loads', async () => {
    const f = factory();
    const onLoadError = vi.fn();
    const onPreviewError = vi.fn();
    const { preview, pending } = asyncPreviewOf('hall');
    render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        preview={preview}
        onLoadError={onLoadError}
        onPreviewError={onPreviewError}
        createViewer={f.createViewer}
      />,
    );
    const v = f.last();
    const refused = new RangeError('preview patch image is empty or already closed');
    v.showPreview.mockImplementation(() => {
      throw refused;
    });
    const { source, close } = closableSource();
    await act(async () => pending[0]?.resolve(source));
    expect(onPreviewError).toHaveBeenCalledWith(refused, 'hall');
    expect(onLoadError).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(v.calls).toEqual(['load:hall']);
  });

  it('reports a failed tile load under a shown preview to onLoadError only', async () => {
    const f = factory();
    const onLoadError = vi.fn();
    const onPreviewError = vi.fn();
    const { preview } = previewOf('hall');
    const missing = new Error('manifest 404');
    const createViewer = vi.fn((el: HTMLElement, opts: ViewerOptions) => {
      const viewer = f.createViewer(el, opts);
      f.last().load.mockRejectedValueOnce(missing);
      return viewer;
    });
    await act(async () => {
      render(
        <PanoStage
          baseUrl="b/"
          panoId="hall"
          preview={preview}
          onLoadError={onLoadError}
          onPreviewError={onPreviewError}
          createViewer={createViewer}
        />,
      );
    });
    expect(f.last().showPreview).toHaveBeenCalledTimes(1);
    expect(onLoadError).toHaveBeenCalledTimes(1);
    expect(onLoadError).toHaveBeenCalledWith(missing, 'hall');
    expect(onPreviewError).not.toHaveBeenCalled();
  });

  it('loads a pano again after the stage went empty and came back to it', () => {
    const f = factory();
    const { rerender } = render(
      <PanoStage baseUrl="b/" panoId="hall" createViewer={f.createViewer} />,
    );
    const v = f.last();
    rerender(<PanoStage baseUrl="b/" panoId={null} createViewer={f.createViewer} />);
    rerender(<PanoStage baseUrl="b/" panoId="hall" createViewer={f.createViewer} />);
    expect(v.load).toHaveBeenCalledTimes(2);
  });

  describe('after a WebGL context restore', () => {
    it('shows the preview again, with replacesVersion, then loads', () => {
      const f = factory();
      const { preview, source, sources } = previewOf('hall', { replacesVersion: 'v1' });
      render(
        <PanoStage baseUrl="b/" panoId="hall" preview={preview} createViewer={f.createViewer} />,
      );
      const v = f.last();
      expect(v.calls).toEqual(['show:hall', 'load:hall']);

      act(() => {
        v.emit('context-lost');
        v.emit('context-restored');
      });

      expect(source).toHaveBeenCalledTimes(2);
      expect(v.calls).toEqual(['show:hall', 'load:hall', 'show:hall', 'load:hall']);
      expect(v.showPreview).toHaveBeenLastCalledWith('hall', sources[1], { replacesVersion: 'v1' });
      // A preview is not a pano change: the camera stays where it is.
      expect(v.setView).not.toHaveBeenCalled();
      expect(v.load).toHaveBeenLastCalledWith('hall');
    });

    it('leaves the reload to the viewer without a preview', () => {
      const f = factory();
      render(<PanoStage baseUrl="b/" panoId="hall" createViewer={f.createViewer} />);
      const v = f.last();
      act(() => v.emit('context-restored'));
      expect(v.calls).toEqual(['load:hall']);
    });

    it("reports the viewer's own failed reload to onLoadError", () => {
      const f = factory();
      const onLoadError = vi.fn();
      render(
        <PanoStage
          baseUrl="b/"
          panoId="hall"
          onLoadError={onLoadError}
          createViewer={f.createViewer}
        />,
      );
      const lost = new Error('manifest 503');
      act(() => f.last().emit('load-error', { error: lost, id: 'hall' }));
      expect(onLoadError).toHaveBeenCalledWith(lost, 'hall');
    });
  });

  describe('going back after a failed change', () => {
    async function failedHop(over: { reloadKey?: string } = {}) {
      const f = factory();
      const onLoadError = vi.fn();
      const stage = (panoId: string, reloadKey?: string) => (
        <PanoStage
          baseUrl="b/"
          panoId={panoId}
          transition
          {...(reloadKey !== undefined && { reloadKey })}
          onLoadError={onLoadError}
          createViewer={f.createViewer}
        />
      );
      const { rerender } = render(stage('hall'));
      const v = f.last();
      act(() => v.emit('scene-change', 'hall'));
      const err = new Error('manifest 500');
      v.transitionTo.mockRejectedValueOnce(err);
      await act(async () => rerender(stage('nave')));
      expect(onLoadError).toHaveBeenCalledWith(err, 'nave');
      await act(async () => rerender(stage('hall', over.reloadKey)));
      return { v, rerender, stage };
    }

    it('does not reload the pano the viewer still has on screen', async () => {
      const { v, rerender, stage } = await failedHop();
      expect(v.transitionTo.mock.calls.map((c) => c[0])).toEqual(['nave']);
      expect(v.calls).toEqual(['load:hall']);

      // It is the pano on stage again: the same link can be tried again.
      await act(async () => rerender(stage('nave')));
      expect(v.transitionTo.mock.calls.map((c) => c[0])).toEqual(['nave', 'nave']);
    });

    it('reloads it when its reloadKey changed meanwhile', async () => {
      const { v } = await failedHop({ reloadKey: 'v2' });
      expect(v.transitionTo.mock.calls.map((c) => c[0])).toEqual(['nave', 'hall']);
    });

    it("loads it when the viewer's own reload of it after a context restore failed", async () => {
      const f = factory();
      const stage = (panoId: string) => (
        <PanoStage
          baseUrl="b/"
          panoId={panoId}
          transition
          onLoadError={() => {}}
          createViewer={f.createViewer}
        />
      );
      const { rerender } = render(stage('hall'));
      const v = f.last();
      act(() => v.emit('scene-change', 'hall'));
      act(() => {
        v.emit('context-lost');
        v.emit('context-restored');
        v.emit('load-error', { error: new Error('manifest 503'), id: 'hall' });
      });
      v.transitionTo.mockRejectedValueOnce(new Error('manifest 500'));
      await act(async () => rerender(stage('nave')));
      await act(async () => rerender(stage('hall')));
      // Nothing of hall is on screen any more: it has to be loaded.
      expect(v.transitionTo.mock.calls.map((c) => c[0])).toEqual(['nave', 'hall']);
    });

    it('loads it again when its own load failed after it landed', async () => {
      const f = factory();
      const { preview } = previewOf('hall');
      const stage = (panoId: string) => (
        <PanoStage
          baseUrl="b/"
          panoId={panoId}
          preview={preview}
          transition
          onLoadError={() => {}}
          createViewer={f.createViewer}
        />
      );
      const { rerender } = render(stage('hall'));
      const v = f.last();
      // The preview landed (the viewer reports it on screen), then its tiles
      // failed to load: what the stage has for hall is not settled.
      v.showPreview.mockImplementation((pano) => {
        v.calls.push(`show:${pano}`);
        v.emit('scene-change', pano);
      });
      v.load.mockRejectedValueOnce(new Error('manifest 404'));
      act(() => {
        v.emit('context-lost');
        v.emit('context-restored');
      });
      await act(async () => {});
      v.transitionTo.mockRejectedValueOnce(new Error('manifest 500'));
      await act(async () => rerender(stage('nave')));
      await act(async () => rerender(stage('hall')));
      expect(v.calls.filter((c) => c === 'show:hall')).toHaveLength(3);
    });

    it('loads it when the change was only superseded, not failed', () => {
      const f = factory();
      const stage = (panoId: string) => (
        <PanoStage baseUrl="b/" panoId={panoId} transition createViewer={f.createViewer} />
      );
      const { rerender } = render(stage('hall'));
      const v = f.last();
      act(() => v.emit('scene-change', 'hall'));
      v.transitionTo.mockReturnValueOnce(new Promise(() => {}));
      rerender(stage('nave'));
      // The hop is still in flight; only a new load cancels it.
      rerender(stage('hall'));
      expect(v.transitionTo.mock.calls.map((c) => c[0])).toEqual(['nave', 'hall']);
    });
  });
});
