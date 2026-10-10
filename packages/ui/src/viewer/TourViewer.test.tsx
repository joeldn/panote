import type { PanoViewer } from '@panote/viewer';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TourViewer, type TourViewerData, type TourViewerProps } from './TourViewer.js';

type Handler = (payload: string) => void;

class FakeViewer {
  handlers = new Map<string, Set<Handler>>();
  fail = false;
  load = vi.fn(async (pano: string) => {
    if (this.fail) throw new Error('manifest 404');
    this.emit('scene-change', pano);
  });
  transitionTo = vi.fn(async (pano: string, _view?: unknown) => this.emit('scene-change', pano));
  setView = vi.fn();
  getView = () => ({ yaw: 0, pitch: 0, fov: 70 });
  setNorth = vi.fn();
  setAutoRotate = vi.fn();
  dispose = vi.fn();
  onRender = () => () => {};
  project = () => ({ x: 0, y: 0, behind: false });
  heading = () => 0;
  reportHotspotOpen = vi.fn((id: string) => this.emit('hotspot-open', id));
  on = (type: string, fn: Handler) => {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)?.add(fn);
  };
  off = (type: string, fn: Handler) => this.handlers.get(type)?.delete(fn);
  emit(type: string, payload: string) {
    this.handlers.get(type)?.forEach((fn) => fn(payload));
  }
}

const settings = {
  controls: 'bottom',
  showMap: true,
  showCompass: true,
  autoRotate: false,
} as const;

const data = (over: Partial<TourViewerData> = {}): TourViewerData => ({
  tour: {
    start: 'square',
    scenes: {
      square: { links: [{ to: 'church', yaw: 1 }], initialView: { yaw: 0.5 } },
      church: { links: [] },
    },
  },
  hotspots: {
    square: [{ source: { id: 'i1', type: 'info', yaw: 0.2, pitch: 0.1, title: 'Fountain' } }],
    church: [{ source: { id: 'i2', type: 'info', yaw: 0.3, pitch: 0, title: 'Altar' } }],
  },
  links: { square: [{ to: 'church', yaw: 1, label: 'To the church' }], church: [] },
  north: { square: 0.3 },
  titles: { square: 'Square', church: 'Church' },
  mapPositions: {},
  settings,
  ...over,
});

function renderViewer(props: Partial<TourViewerProps> = {}) {
  const viewers: FakeViewer[] = [];
  const createViewer = () => {
    const v = new FakeViewer();
    viewers.push(v);
    return v as unknown as PanoViewer;
  };
  render(
    <TourViewer
      data={data()}
      title="Old town"
      baseUrl="https://cdn.test/tiles/"
      start="square"
      isAllowedMediaUrl={() => true}
      createViewer={createViewer}
      {...props}
    />,
  );
  return { viewer: () => viewers[viewers.length - 1]! };
}

afterEach(cleanup);

describe('TourViewer', () => {
  it('opens on the start scene with its initial view and north', async () => {
    const { viewer } = renderViewer();
    await waitFor(() =>
      expect(viewer().load).toHaveBeenCalledWith('square', { view: { yaw: 0.5 } }),
    );
    expect(viewer().setView).not.toHaveBeenCalled();
    expect(viewer().setNorth).toHaveBeenCalledWith(0.3);
    expect(screen.getByLabelText('Old town: Square')).toBeTruthy();
  });

  it('renders the bar slots around the breadcrumb, with the scene on screen', async () => {
    const extras = vi.fn((panoId: string) => <span>extras for {panoId}</span>);
    renderViewer({
      bar: { home: <a href="/">home</a>, extras, end: <a href="/edit">Back to editor</a> },
    });
    const crumbs = screen.getByRole('navigation', { name: 'Tour' });
    expect(within(crumbs).getByText('Old town')).toBeTruthy();
    expect(within(crumbs).getByText('Square').getAttribute('aria-current')).toBe('location');
    expect(screen.getByText('extras for square')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'home' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to editor' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to To the church' }));
    expect(await screen.findByText('extras for church')).toBeTruthy();
  });

  it('has no bar without one (the embed)', () => {
    renderViewer();
    expect(screen.queryByRole('navigation', { name: 'Tour' })).toBeNull();
  });

  it('walks links and the map, reporting scenes and point opens', async () => {
    const onSceneChange = vi.fn();
    const onHotspotOpen = vi.fn();
    const { viewer } = renderViewer({ onSceneChange, onHotspotOpen });
    await waitFor(() => expect(onSceneChange).toHaveBeenCalledWith('square'));
    fireEvent.click(screen.getByRole('button', { name: 'Fountain' }));
    expect(onHotspotOpen).toHaveBeenCalledWith('square', 'i1');
    expect(screen.getByRole('complementary')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to To the church' }));
    await waitFor(() => expect(onSceneChange).toHaveBeenCalledWith('church'));
    expect(viewer().transitionTo.mock.calls[0]?.[0]).toBe('church');
    // Moving on closes the open point.
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('reports a point opened on a later scene with that scene', async () => {
    const onHotspotOpen = vi.fn();
    const onSceneChange = vi.fn();
    renderViewer({ onHotspotOpen, onSceneChange });
    fireEvent.click(screen.getByRole('button', { name: 'Go to To the church' }));
    await waitFor(() => expect(onSceneChange).toHaveBeenCalledWith('church'));
    fireEvent.click(screen.getByRole('button', { name: 'Altar' }));
    expect(onHotspotOpen).toHaveBeenCalledExactlyOnceWith('church', 'i2');
  });

  it('honours the tour settings', async () => {
    const { viewer } = renderViewer({
      data: data({
        settings: { controls: 'top', showMap: false, showCompass: false, autoRotate: true },
      }),
    });
    expect(screen.getByRole('toolbar').className).toContain('pn-controls--top');
    expect(document.querySelector('.pn-compass')).toBeNull();
    expect(document.querySelector('.pn-scenemap')).toBeNull();
    await waitFor(() => expect(viewer().setAutoRotate).toHaveBeenCalledWith(true));
  });

  it('shows the compass and map by default', () => {
    renderViewer();
    expect(document.querySelector('.pn-compass')).toBeTruthy();
    expect(document.querySelector('.pn-scenemap')).toBeTruthy();
  });

  it('pins one scene with no links or map when single', () => {
    renderViewer({ single: true });
    expect(screen.queryByRole('button', { name: 'Go to To the church' })).toBeNull();
    expect(document.querySelector('.pn-scenemap')).toBeNull();
  });

  it('offers Share only with an onShare', () => {
    renderViewer();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    cleanup();
    const onShare = vi.fn();
    renderViewer({ onShare });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(onShare).toHaveBeenCalledOnce();
  });

  it('reports a failed load with the pano and keeps the chrome', async () => {
    const onLoadError = vi.fn();
    const viewers: FakeViewer[] = [];
    render(
      <TourViewer
        data={data()}
        title="Old town"
        baseUrl="https://cdn.test/tiles/"
        start="square"
        isAllowedMediaUrl={() => true}
        bar={{ home: null }}
        onLoadError={onLoadError}
        createViewer={() => {
          const v = new FakeViewer();
          v.fail = true;
          viewers.push(v);
          return v as unknown as PanoViewer;
        }}
      />,
    );
    await waitFor(() => expect(onLoadError).toHaveBeenCalledWith(expect.any(Error), 'square'));
    expect(screen.getByRole('navigation', { name: 'Tour' })).toBeTruthy();
  });

  it('renders overlay and children', async () => {
    renderViewer({
      overlay: (panoId) => <p>overlay {panoId}</p>,
      children: <p>after the stage</p>,
    });
    expect(screen.getByText('overlay square')).toBeTruthy();
    expect(screen.getByText('after the stage')).toBeTruthy();
    await act(async () => {});
  });
});
