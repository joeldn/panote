import type { PanoViewer } from '@panote/viewer';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TourViewer, type TourViewerData, type TourViewerProps } from './TourViewer.js';

type Handler = (payload: string) => void;

interface PendingTransition {
  pano: string;
  /** Lands the pano: emits scene-change, as the viewer does once it is drawable, then resolves. */
  resolve: () => void;
  reject: (err: unknown) => void;
}

class FakeViewer {
  /** Like the real viewer's: in the host, focusable for its keys. */
  canvas = document.createElement('canvas');
  constructor(host?: HTMLElement) {
    this.canvas.tabIndex = 0;
    host?.appendChild(this.canvas);
  }
  focus = vi.fn(() => this.canvas.focus({ preventScroll: true }));
  handlers = new Map<string, Set<Handler>>();
  fail = false;
  /** When set, transitionTo stays pending until the test settles it from `pending`. */
  defer = false;
  pending: PendingTransition[] = [];
  load = vi.fn(async (pano: string) => {
    if (this.fail) throw new Error('manifest 404');
    this.emit('scene-change', pano);
  });
  transitionTo = vi.fn(async (pano: string, _view?: unknown) => {
    if (!this.defer) return this.emit('scene-change', pano);
    return new Promise<void>((resolve, reject) => {
      this.pending.push({
        pano,
        resolve: () => {
          this.emit('scene-change', pano);
          resolve();
        },
        reject,
      });
    });
  });
  setView = vi.fn();
  getView = () => ({ yaw: 0, pitch: 0, fov: 70 });
  /** What isSettled() answers. */
  settled = false;
  isSettled = () => this.settled;
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

  it('closes the open point on a second click of its marker', () => {
    const onHotspotOpen = vi.fn();
    renderViewer({ onHotspotOpen });
    const marker = screen.getByRole('button', { name: 'Fountain' });
    fireEvent.click(marker);
    expect(screen.getByRole('complementary')).toBeTruthy();
    expect(marker.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(marker);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(marker.getAttribute('aria-pressed')).toBe('false');
    expect(onHotspotOpen).toHaveBeenCalledOnce();
  });

  it('hands focus back to a tapped marker when its point closes', () => {
    renderViewer();
    // A tap on Safari or iOS leaves the marker unfocused.
    const marker = screen.getByRole('button', { name: 'Fountain' });
    fireEvent.click(marker);
    const panel = screen.getByRole('complementary', { name: 'Fountain' });
    expect(panel.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(document.activeElement).toBe(marker);
  });

  it('starts with auto-rotate off when the visitor prefers reduced motion', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' })),
    );
    try {
      const { viewer } = renderViewer({
        data: data({ settings: { ...settings, autoRotate: true } }),
      });
      await waitFor(() => expect(viewer().load).toHaveBeenCalled());
      expect(viewer().setAutoRotate).not.toHaveBeenCalledWith(true);
      expect(screen.getByRole('button', { name: 'Auto-rotate' }).getAttribute('aria-pressed')).toBe(
        'false',
      );
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('leaves fullscreen before sharing, and handles a refused exit', () => {
    const onShare = vi.fn();
    // A rejection with no handler attached is an unhandled rejection in the page.
    const refused = Promise.reject(new TypeError('not allowed'));
    const then = refused.then.bind(refused);
    let handled = false;
    refused.then = ((ok?: unknown, fail?: unknown) => {
      if (fail) handled = true;
      return then(ok as never, fail as never);
    }) as typeof refused.then;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: document.body,
    });
    let exits = 0;
    // A plain function: a vi.fn would attach its own handlers to track the result.
    document.exitFullscreen = () => {
      exits += 1;
      return refused;
    };
    try {
      renderViewer({ onShare });
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));
      expect(exits).toBe(1);
      expect(onShare).toHaveBeenCalledOnce();
      expect(handled).toBe(true);
    } finally {
      void then(undefined, () => {});
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      delete (document as { exitFullscreen?: unknown }).exitFullscreen;
    }
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

  describe('while a scene change is in flight', () => {
    const crumb = () =>
      within(screen.getByRole('navigation', { name: 'Tour' })).getByText(
        (_, el) => el?.getAttribute('aria-current') === 'location',
      ).textContent;
    const mapCurrent = () => {
      const toggle = screen.getByRole('button', { name: 'Map' });
      if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
      return document.querySelector('.pn-scenemap__item[aria-current="location"]')?.textContent;
    };

    async function startTransition(props: Partial<TourViewerProps> = {}) {
      const r = renderViewer({
        data: data({ north: { square: 0.3, church: 0.9 } }),
        bar: { home: null },
        ...props,
      });
      await waitFor(() => expect(r.viewer().load.mock.calls[0]?.[0]).toBe('square'));
      r.viewer().defer = true;
      fireEvent.click(screen.getByRole('button', { name: 'Go to To the church' }));
      await waitFor(() => expect(r.viewer().pending).toHaveLength(1));
      return r;
    }

    it('hides the markers and chevrons and keeps the rest on the scene on screen', async () => {
      const { viewer } = await startTransition();
      // Neither the old scene's points nor the new one's are clickable over the old pano.
      expect(screen.queryByRole('button', { name: 'Fountain' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Altar' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Go to To the church' })).toBeNull();
      expect(crumb()).toBe('Square');
      expect(mapCurrent()).toBe('Square');
      expect(screen.getByLabelText('Old town: Square')).toBeTruthy();
      expect(viewer().setNorth).toHaveBeenLastCalledWith(0.3);

      await act(async () => viewer().pending[0]!.resolve());

      expect(screen.getByRole('button', { name: 'Altar' })).toBeTruthy();
      expect(crumb()).toBe('Church');
      expect(mapCurrent()).toBe('Church');
      expect(screen.getByLabelText('Old town: Church')).toBeTruthy();
      expect(viewer().setNorth).toHaveBeenLastCalledWith(0.9);
    });

    it('hands focus to the stage when the focused chevron hides for the move', async () => {
      renderViewer({
        createViewer: (el) => {
          const v = new FakeViewer(el);
          v.defer = true;
          return v as unknown as PanoViewer;
        },
      });
      const chevron = await screen.findByRole('button', { name: 'Go to To the church' });
      chevron.focus();
      fireEvent.click(chevron);
      expect(screen.queryByRole('button', { name: 'Go to To the church' })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('application').querySelector('canvas'));
    });

    it('leaves focus alone when the move starts from outside the markers', async () => {
      renderViewer({
        createViewer: (el) => {
          const v = new FakeViewer(el);
          v.defer = true;
          return v as unknown as PanoViewer;
        },
      });
      await screen.findByRole('button', { name: 'Go to To the church' });
      fireEvent.click(screen.getByRole('button', { name: 'Map' }));
      const toggle = screen.getByRole('button', { name: 'Map' });
      toggle.focus();
      fireEvent.click(screen.getByRole('button', { name: 'Church' }));
      expect(document.activeElement).toBe(toggle);
    });

    it('goes back to the scene on screen from the map, keeping the camera', async () => {
      const { viewer } = await startTransition();
      const pick = (name: string) => {
        fireEvent.click(screen.getByRole('button', { name: 'Map' }));
        fireEvent.click(screen.getByRole('button', { name }));
      };
      // Already heading there.
      pick('Church, loading');
      expect(viewer().transitionTo).toHaveBeenCalledTimes(1);

      pick('Square');
      await waitFor(() => expect(viewer().pending).toHaveLength(2));
      expect(viewer().transitionTo).toHaveBeenLastCalledWith('square', undefined);
      await act(async () => viewer().pending[1]!.resolve());
      expect(screen.getByRole('button', { name: 'Go to To the church' })).toBeTruthy();
      expect(crumb()).toBe('Square');
    });

    it('snaps back to the scene on screen when the load fails, and can retry', async () => {
      const onLoadError = vi.fn();
      const onSceneChange = vi.fn();
      const { viewer } = await startTransition({ onLoadError, onSceneChange });
      const err = new Error('manifest 500');

      await act(async () => viewer().pending[0]!.reject(err));

      expect(onLoadError).toHaveBeenCalledWith(err, 'church');
      expect(screen.getByRole('button', { name: 'Fountain' })).toBeTruthy();
      expect(crumb()).toBe('Square');
      // The pano on screen is still the one the viewer landed: no reload of it.
      expect(viewer().transitionTo).toHaveBeenCalledTimes(1);
      expect(viewer().load).toHaveBeenCalledTimes(1);
      expect(onSceneChange.mock.calls).toEqual([['square']]);

      fireEvent.click(screen.getByRole('button', { name: 'Go to To the church' }));
      await waitFor(() => expect(viewer().pending.at(-1)!.pano).toBe('church'));
      expect(viewer().transitionTo).toHaveBeenCalledTimes(2);
    });

    it('stays put when the reload of a scene that never landed fails too', async () => {
      const onLoadError = vi.fn();
      let v!: FakeViewer;
      renderViewer({
        bar: { home: null },
        onLoadError,
        createViewer: () => {
          v = new FakeViewer();
          // The start scene never loads, so nothing the stage asked for landed.
          v.fail = true;
          return v as unknown as PanoViewer;
        },
      });
      await waitFor(() => expect(onLoadError).toHaveBeenCalledTimes(1));
      v.defer = true;
      onLoadError.mockClear();

      fireEvent.click(screen.getByRole('button', { name: 'Go to To the church' }));
      await waitFor(() => expect(v.pending).toHaveLength(1));
      const first = new Error('church 500');
      await act(async () => v.pending[0]!.reject(first));
      // Back to the start scene, which the stage loads again since it never landed.
      await waitFor(() => expect(v.pending).toHaveLength(2));
      expect(v.pending[1]!.pano).toBe('square');
      const second = new Error('square 500');
      await act(async () => v.pending[1]!.reject(second));

      expect(onLoadError.mock.calls).toEqual([
        [first, 'church'],
        [second, 'square'],
      ]);
      // No further loads: the failure of the scene on screen is not chased.
      expect(v.transitionTo).toHaveBeenCalledTimes(2);
      expect(crumb()).toBe('Square');
      expect(screen.getByRole('button', { name: 'Go to To the church' })).toBeTruthy();
    });
  });

  describe('prefetching linked scenes', () => {
    const many = () =>
      data({
        links: {
          square: [
            { to: 'church', yaw: 1, label: 'To the church' },
            { to: 'church', yaw: 1.2, label: 'Also the church' },
            { to: 'tower', yaw: 2 },
            { to: 'bridge', yaw: 3 },
            { to: 'market', yaw: 4 },
          ],
          church: [],
        },
        titles: { square: 'Square', church: 'Church', tower: 'Tower', bridge: 'Bridge' },
      });
    const settle = (v: FakeViewer) =>
      act(() => v.emit('tiles-settled', undefined as unknown as string));

    it('fetches up to three link targets, only once the scene on screen has settled', async () => {
      const prefetch = vi.fn(async () => {});
      const { viewer } = renderViewer({ data: many(), prefetch });
      await waitFor(() => expect(viewer().load.mock.calls[0]?.[0]).toBe('square'));
      expect(prefetch).not.toHaveBeenCalled();

      settle(viewer());

      expect(prefetch.mock.calls.map((c: unknown[]) => c.slice(0, 2))).toEqual([
        ['https://cdn.test/tiles/', 'church'],
        ['https://cdn.test/tiles/', 'tower'],
        ['https://cdn.test/tiles/', 'bridge'],
      ]);
      // Later settles (after each pan) don't fetch again.
      settle(viewer());
      expect(prefetch).toHaveBeenCalledTimes(3);
    });

    it('fetches at once for a scene that settled before the prefetch subscribed', async () => {
      const prefetch = vi.fn(async () => {});
      renderViewer({
        data: many(),
        prefetch,
        createViewer: () => {
          const v = new FakeViewer();
          // Its base was all it needed: settled by the time the scene is shown.
          v.settled = true;
          return v as unknown as PanoViewer;
        },
      });
      await waitFor(() => expect(prefetch).toHaveBeenCalledTimes(3));
      expect(prefetch.mock.calls.map((c: unknown[]) => c[1])).toEqual([
        'church',
        'tower',
        'bridge',
      ]);
    });

    it('waits for the start scene to land even when the empty viewer counts as settled', async () => {
      const prefetch = vi.fn(async () => {});
      let v!: FakeViewer;
      renderViewer({
        data: many(),
        prefetch,
        createViewer: () => {
          v = new FakeViewer();
          v.settled = true;
          v.load.mockImplementation(() => new Promise<void>(() => {}));
          return v as unknown as PanoViewer;
        },
      });
      await waitFor(() => expect(v.load).toHaveBeenCalled());
      await act(async () => {});
      expect(prefetch).not.toHaveBeenCalled();

      act(() => v.emit('scene-change', 'square'));
      expect(prefetch).toHaveBeenCalledTimes(3);
    });

    it('waits for a new viewer (a new baseUrl) to land its scene too', async () => {
      const prefetch = vi.fn(async () => {});
      const made: FakeViewer[] = [];
      const createViewer = () => {
        const v = new FakeViewer();
        v.settled = true;
        // The second viewer's load never lands.
        if (made.length > 0) v.load.mockImplementation(() => new Promise<void>(() => {}));
        made.push(v);
        return v as unknown as PanoViewer;
      };
      const props = {
        data: many(),
        title: 'Old town',
        start: 'square',
        isAllowedMediaUrl: () => true,
        prefetch,
        createViewer,
      };
      const { rerender } = render(<TourViewer {...props} baseUrl="https://a.test/" />);
      await waitFor(() => expect(prefetch).toHaveBeenCalledTimes(3));

      rerender(<TourViewer {...props} baseUrl="https://b.test/" />);
      await waitFor(() => expect(made[1]?.load).toHaveBeenCalled());
      await act(async () => {});
      expect(prefetch).toHaveBeenCalledTimes(3);

      // Back to the first base before b's scene landed: a third viewer, as empty.
      rerender(<TourViewer {...props} baseUrl="https://a.test/" />);
      await waitFor(() => expect(made[2]?.load).toHaveBeenCalled());
      await act(async () => {});
      expect(prefetch).toHaveBeenCalledTimes(3);

      act(() => made[2]!.emit('scene-change', 'square'));
      expect(prefetch).toHaveBeenLastCalledWith('https://a.test/', 'bridge', expect.anything());
      expect(prefetch).toHaveBeenCalledTimes(6);
    });

    it('cancels them when the visitor moves on', async () => {
      const signals: AbortSignal[] = [];
      const prefetch = vi.fn(async (_b: string, _p: string, o?: { signal?: AbortSignal }) => {
        if (o?.signal) signals.push(o.signal);
      });
      const { viewer } = renderViewer({ data: many(), prefetch });
      await waitFor(() => expect(viewer().load.mock.calls[0]?.[0]).toBe('square'));
      settle(viewer());
      expect(signals).toHaveLength(3);
      expect(signals.some((s) => s.aborted)).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Go to Tower' }));

      expect(signals.every((s) => s.aborted)).toBe(true);
    });

    it('fetches nothing for a single scene', async () => {
      const prefetch = vi.fn(async () => {});
      const { viewer } = renderViewer({ data: many(), prefetch, single: true });
      await waitFor(() => expect(viewer().load.mock.calls[0]?.[0]).toBe('square'));
      settle(viewer());
      expect(prefetch).not.toHaveBeenCalled();
    });
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
