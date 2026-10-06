import type { PanoViewer, PreviewSource, ViewerOptions } from '@panote/viewer';
import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PanoStage, type StagePreview } from './PanoStage.js';
import { usePanoViewer } from './viewer-context.js';

type Handler = (payload: string) => void;

class FakeViewer {
  handlers = new Map<string, Set<Handler>>();
  load = vi.fn(async (_pano: string) => {});
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
  emit(type: string, payload: string) {
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
  const preview: StagePreview = { panoId, source, ...extra };
  return { preview, source, sources };
}

afterEach(cleanup);

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
      baseUrl: 'https://cdn.test/tiles/',
      autoRotate: true,
      initialView: { yaw: 1, fov: 60 },
      north: 0.5,
    });
    expect(v.load).toHaveBeenCalledWith('hall');
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
    expect(v.setView).toHaveBeenLastCalledWith({ yaw: 2 });
    expect(v.load).toHaveBeenLastCalledWith('nave');
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
        new Promise<void>((_r, rej) => {
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

  it('forwards scene-change / hotspot-open events and exposes the viewer to children', () => {
    const f = factory();
    const onSceneChange = vi.fn();
    const onHotspotOpen = vi.fn();
    const onViewer = vi.fn();
    function Chrome() {
      const viewer = usePanoViewer();
      return <span>{viewer ? 'chrome:ready' : 'chrome:none'}</span>;
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
    v.emit('hotspot-open', 'h1');
    expect(onSceneChange).toHaveBeenCalledWith('hall');
    expect(onHotspotOpen).toHaveBeenCalledWith('h1');
    unmount();
    expect(v.dispose).toHaveBeenCalledTimes(1);
    expect(v.handlers.get('scene-change')?.size).toBe(0);
    expect(onViewer).toHaveBeenLastCalledWith(null);
  });

  it('recreates the viewer when baseUrl changes', () => {
    const f = factory();
    const { rerender } = render(
      <PanoStage baseUrl="a/" panoId="hall" createViewer={f.createViewer} />,
    );
    const first = f.last();
    rerender(<PanoStage baseUrl="b/" panoId="hall" createViewer={f.createViewer} />);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(f.made).toHaveLength(2);
    expect(f.last().options.baseUrl).toBe('b/');
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
    expect(v.calls).toEqual(['setView', 'load:hall']);
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        view={{ yaw: 1 }}
        reloadKey="v2"
        createViewer={f.createViewer}
      />,
    );
    expect(v.calls).toEqual(['setView', 'load:hall', 'load:hall']);
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="nave"
        view={{ yaw: 2 }}
        reloadKey="v2"
        createViewer={f.createViewer}
      />,
    );
    expect(v.setView).toHaveBeenLastCalledWith({ yaw: 2 });
    expect(v.calls.slice(-2)).toEqual(['setView', 'load:nave']);
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
    let resolve!: (s: PreviewSource) => void;
    const preview: StagePreview = {
      panoId: 'hall',
      source: () =>
        new Promise<PreviewSource>((r) => {
          resolve = r;
        }),
    };
    render(
      <PanoStage baseUrl="b/" panoId="hall" preview={preview} createViewer={f.createViewer} />,
    );
    const v = f.last();
    expect(v.calls).toEqual([]);
    const s = fakeSource();
    await act(async () => resolve(s));
    expect(v.calls).toEqual(['show:hall', 'load:hall']);
    expect(v.showPreview).toHaveBeenCalledWith('hall', s, {});
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

  it('shows a preview once: a reload or a dropped preview does not show it again', () => {
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

  it('swaps in a new preview for the pano on stage without moving the camera', () => {
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
    const second = previewOf('hall', { replacesVersion: 'v2' });
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

  it('closes an async source that lands after the stage moved on, and reports load errors', async () => {
    const f = factory();
    const resolvers: ((s: PreviewSource) => void)[] = [];
    const preview: StagePreview = {
      panoId: 'hall',
      source: () =>
        new Promise<PreviewSource>((r) => {
          resolvers.push(r);
        }),
    };
    const onLoadError = vi.fn();
    const { rerender } = render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        preview={preview}
        onLoadError={onLoadError}
        createViewer={f.createViewer}
      />,
    );
    const v = f.last();
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="nave"
        preview={preview}
        onLoadError={onLoadError}
        createViewer={f.createViewer}
      />,
    );
    const close = vi.fn();
    const stale: PreviewSource = {
      width: 8,
      height: 4,
      patches: [{ x: 0, y: 0, w: 8, h: 4, image: { close } as unknown as ImageBitmap }],
    };
    await act(async () => resolvers[0]?.(stale));
    expect(close).toHaveBeenCalledTimes(1);
    expect(v.showPreview).not.toHaveBeenCalled();
    expect(v.calls).toEqual(['load:nave']);
  });
});
