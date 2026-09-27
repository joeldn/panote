import type { PanoViewer, ViewerOptions } from '@panote/viewer';
import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PanoStage } from './PanoStage.js';
import { usePanoViewer } from './viewer-context.js';

type Handler = (payload: string) => void;

class FakeViewer {
  handlers = new Map<string, Set<Handler>>();
  load = vi.fn(async (_pano: string) => {});
  transitionTo = vi.fn(async (_pano: string, _view?: unknown) => {});
  setView = vi.fn();
  setNorth = vi.fn();
  setAutoRotate = vi.fn();
  dispose = vi.fn();
  constructor(
    readonly container: HTMLElement,
    readonly options: ViewerOptions,
  ) {}
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
});
