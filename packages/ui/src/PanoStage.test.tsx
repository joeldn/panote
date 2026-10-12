import {
  WebGLUnavailableError,
  type LoadOptions,
  type PanoViewerApi,
  type PanoViewerEvents,
  type PreviewSource,
  type View,
  type ViewerOptions,
} from '@panote/viewer';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useEffect, useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { panoteViewerPreset } from './panote-viewer.js';
import { PanoStage, type StagePreview } from './PanoStage.js';
import { useStageEvents } from './stage-events.js';
import { usePanoViewer } from './viewer-context.js';

class FakeViewer implements PanoViewerApi {
  load = vi.fn(async (_pano: string, _opts?: LoadOptions) => true);
  /** A load with a transition: `load` hands those here, so a test can script hops apart. */
  crossfade = vi.fn(async (_pano: string, _view?: Partial<View>) => true);
  showPreview = vi.fn((_pano: string, _source: PreviewSource, _opts?: unknown) => {});
  cancelLoad = vi.fn(() => {
    this.calls.push('cancel');
  });
  /** Viewer calls in order, to check that the preview goes up before the load. */
  calls: string[] = [];
  setView = vi.fn();
  setNorth = vi.fn();
  setAutoRotate = vi.fn();
  setLabel = vi.fn();
  dispose = vi.fn();
  // Not used by the stage itself.
  prefetch = vi.fn(async () => {});
  getView = () => ({ yaw: 0, pitch: 0, fov: 70 });
  zoomBy = vi.fn();
  heading = () => 0;
  focus = vi.fn();
  isSettled = () => false;
  project = () => ({ x: 0, y: 0, behind: false });
  directionAtPixel = () => ({ yaw: 0, pitch: 0 });
  onRender = () => () => {};
  requestRender = vi.fn();
  constructor(
    readonly container: HTMLElement,
    readonly options: ViewerOptions,
  ) {
    this.load.mockImplementation(async (pano, opts) => {
      if (opts?.transition) return this.crossfade(pano, opts.view);
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
  readonly handlers = new Map<string, Set<(payload: never) => void>>();
  on<K extends keyof PanoViewerEvents>(
    type: K,
    fn: (payload: PanoViewerEvents[K]) => void,
  ): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)?.add(fn);
    return () => this.off(type, fn);
  }
  off<K extends keyof PanoViewerEvents>(type: K, fn: (payload: PanoViewerEvents[K]) => void): void {
    this.handlers.get(type)?.delete(fn);
  }
  emit<K extends keyof PanoViewerEvents>(type: K, payload?: PanoViewerEvents[K]): void {
    this.handlers.get(type)?.forEach((fn) => (fn as (p: typeof payload) => void)(payload));
  }
}

function factory() {
  const made: FakeViewer[] = [];
  const createViewer = vi.fn((el: HTMLElement, opts: ViewerOptions) => {
    const v = new FakeViewer(el, opts);
    made.push(v);
    return v;
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
        options={{ camera: { maxFov: 90 }, autoRotate: { speed: 0.1 } }}
        aria-label="Town hall"
        createViewer={f.createViewer}
      />,
    );
    expect(f.createViewer).toHaveBeenCalledTimes(1);
    const v = f.last();
    expect(v.container.className).toBe('pn-stage__viewer');
    // panote's preset, with the options merged over it and the props over those.
    const { resolveSource, ...preset } = panoteViewerPreset({ baseUrl: 'https://cdn.test/tiles/' });
    expect(v.options).toEqual({
      ...preset,
      resolveSource: expect.any(Function),
      camera: { ...preset.camera, maxFov: 90, north: 0.5 },
      interaction: { ...preset.interaction, label: 'Town hall' },
      autoRotate: { enabled: true, speed: 0.1, idleMs: 3000 },
      initialView: { yaw: 1, fov: 60 },
    });
    expect(resolveSource).toEqual(expect.any(Function));
    expect(v.load).toHaveBeenCalledWith('hall', { view: { yaw: 1, fov: 60 } });
    expect(v.setNorth).toHaveBeenLastCalledWith(0.5);
    expect(v.setAutoRotate).toHaveBeenLastCalledWith(true);
  });

  it('creates the viewer in the commit that mounts it, before any passive effect', () => {
    const f = factory();
    // A later sibling's layout effect runs after the stage's in the same commit,
    // and a passive effect only after every layout effect.
    const seen: string[] = [];
    function After() {
      useLayoutEffect(() => {
        seen.push(`layout:${f.createViewer.mock.calls.length}`);
      }, []);
      useEffect(() => {
        seen.push(`passive:${f.createViewer.mock.calls.length}`);
      }, []);
      return null;
    }
    render(
      <>
        <PanoStage baseUrl="b/" panoId="hall" createViewer={f.createViewer} />
        <After />
      </>,
    );
    expect(seen).toEqual(['layout:1', 'passive:1']);
    expect(f.createViewer).toHaveBeenCalledWith(
      document.querySelector('.pn-stage__viewer'),
      expect.anything(),
    );
  });

  it('names the viewer canvas, not its own host, and renames it in place', () => {
    const f = factory();
    const { rerender } = render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        aria-label="Tour: Hall"
        createViewer={f.createViewer}
      />,
    );
    const v = f.last();
    expect(v.options.interaction?.label).toBe('Tour: Hall');
    // One application landmark: the canvas. The stage's own elements have no role.
    expect(document.querySelector('[role]')).toBeNull();
    expect(document.querySelector('[aria-label]')).toBeNull();
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        aria-label="Tour: Nave"
        createViewer={f.createViewer}
      />,
    );
    expect(f.createViewer).toHaveBeenCalledTimes(1);
    expect(v.setLabel).toHaveBeenLastCalledWith('Tour: Nave');
  });

  it('labels the canvas "Panorama viewer" without an aria-label', () => {
    const f = factory();
    render(<PanoStage baseUrl="b/" panoId="hall" createViewer={f.createViewer} />);
    expect(f.last().options.interaction?.label).toBe('Panorama viewer');
  });

  it('engages the wheel only for an embed, recreating the viewer when that changes', () => {
    const f = factory();
    const { rerender } = render(
      <PanoStage baseUrl="b/" panoId="hall" createViewer={f.createViewer} />,
    );
    expect(f.last().options.interaction?.wheel).toBe('always');
    rerender(<PanoStage baseUrl="b/" panoId="hall" embed createViewer={f.createViewer} />);
    expect(f.createViewer).toHaveBeenCalledTimes(2);
    expect(f.last().options.interaction?.wheel).toBe('engaged');
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
    expect(v.load).toHaveBeenLastCalledWith('crypt', { view: { yaw: 3 }, transition: true });
    expect(v.crossfade).toHaveBeenCalledWith('crypt', { yaw: 3 });
    expect(v.load).toHaveBeenCalledTimes(3);
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

  describe('auto-rotate under keyboard focus (WCAG 2.2.2)', () => {
    // jsdom never matches :focus-visible, so say which focus came from the keyboard.
    function stage(autoRotate = true, options?: ViewerOptions) {
      let keyboard = false;
      const matches = Element.prototype.matches;
      vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
        this: Element,
        selector: string,
      ) {
        if (!selector.includes(':focus-visible')) return matches.call(this, selector);
        return keyboard && matches.call(this, selector.replaceAll(':focus-visible', ':focus'));
      });
      const f = factory();
      const ui = (markers: boolean, rotate = autoRotate) => (
        <>
          <PanoStage
            baseUrl="b/"
            panoId="hall"
            autoRotate={rotate}
            {...(options && { options })}
            createViewer={f.createViewer}
          >
            {markers && (
              <div className="pn-anchors">
                <button type="button">Kitchen</button>
              </div>
            )}
            <aside className="pn-hspanel" aria-label="Kitchen panel" tabIndex={-1}>
              <a href="#more">More</a>
            </aside>
            <button type="button">Zoom in</button>
          </PanoStage>
          <button type="button">Outside</button>
        </>
      );
      const { rerender, unmount } = render(ui(true));
      const v = f.last();
      // Stands in for the viewer's canvas, which it puts in its container.
      const canvas = document.createElement('canvas');
      canvas.tabIndex = 0;
      v.container.append(canvas);
      const focus = (el: HTMLElement, by: 'keyboard' | 'pointer') => {
        keyboard = by === 'keyboard';
        act(() => el.focus());
      };
      const button = (name: string) => screen.getByRole('button', { name });
      const dropMarkers = () => rerender(ui(false));
      const setAutoRotate = (on: boolean) => rerender(ui(true, on));
      return { v, canvas, focus, button, dropMarkers, setAutoRotate, unmount };
    }
    // The preset's idle window.
    const IDLE_MS = 3000;
    const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('holds still while the viewer has keyboard focus, and goes on an idle window after', () => {
      const { v, canvas, focus, button } = stage();
      focus(canvas, 'keyboard');
      expect(v.setAutoRotate).toHaveBeenLastCalledWith(false);
      v.setAutoRotate.mockClear();
      focus(button('Outside'), 'keyboard');
      wait(IDLE_MS - 1);
      expect(v.setAutoRotate).not.toHaveBeenCalled();
      wait(1);
      expect(v.setAutoRotate).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('waits out the idle window across an unrelated re-render', () => {
      const { v, canvas, focus, button, dropMarkers } = stage();
      focus(canvas, 'keyboard');
      focus(button('Outside'), 'keyboard');
      v.setAutoRotate.mockClear();
      dropMarkers();
      wait(IDLE_MS - 1);
      expect(v.setAutoRotate).not.toHaveBeenCalled();
      wait(1);
      expect(v.setAutoRotate).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('drops a resume still waiting when the stage unmounts', () => {
      const { v, canvas, focus, button, unmount } = stage();
      focus(canvas, 'keyboard');
      focus(button('Outside'), 'keyboard');
      v.setAutoRotate.mockClear();
      unmount();
      wait(IDLE_MS);
      expect(v.setAutoRotate).not.toHaveBeenCalled();
    });

    it("waits the viewer's own idle window from its options", () => {
      const { v, canvas, focus, button } = stage(true, { autoRotate: { idleMs: 500 } });
      focus(canvas, 'keyboard');
      focus(button('Outside'), 'keyboard');
      v.setAutoRotate.mockClear();
      wait(499);
      expect(v.setAutoRotate).not.toHaveBeenCalled();
      wait(1);
      expect(v.setAutoRotate).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('waits an idle window from a drag made while a resume is waiting', () => {
      const { v, canvas, focus, button } = stage();
      focus(canvas, 'keyboard');
      focus(button('Outside'), 'keyboard');
      v.setAutoRotate.mockClear();
      // A drag 1 s before the resume was due.
      wait(IDLE_MS - 1000);
      fireEvent.pointerDown(canvas, { buttons: 1 });
      fireEvent.pointerMove(canvas, { buttons: 1 });
      wait(IDLE_MS - 1);
      expect(v.setAutoRotate).not.toHaveBeenCalled();
      wait(1);
      expect(v.setAutoRotate).toHaveBeenCalledExactlyOnceWith(true);
    });

    it("doesn't wait longer for a pointer that only hovers", () => {
      const { v, canvas, focus, button } = stage();
      focus(canvas, 'keyboard');
      focus(button('Outside'), 'keyboard');
      v.setAutoRotate.mockClear();
      wait(IDLE_MS - 1000);
      fireEvent.pointerMove(canvas, { buttons: 0 });
      wait(1000);
      expect(v.setAutoRotate).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('leaves auto-rotate alone on a drag with no resume waiting', () => {
      const { v, canvas, focus, button } = stage();
      focus(canvas, 'keyboard');
      focus(button('Outside'), 'keyboard');
      wait(IDLE_MS);
      v.setAutoRotate.mockClear();
      fireEvent.pointerDown(canvas, { buttons: 1 });
      wait(IDLE_MS);
      expect(v.setAutoRotate).not.toHaveBeenCalled();
    });

    it('turns at once when switched back on after a hold let go while it was off', () => {
      const { v, canvas, focus, button, setAutoRotate } = stage();
      focus(canvas, 'keyboard');
      setAutoRotate(false);
      focus(button('Outside'), 'keyboard');
      v.setAutoRotate.mockClear();
      setAutoRotate(true);
      expect(v.setAutoRotate).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('stays held when keyboard focus comes back within the idle window', () => {
      const { v, canvas, focus, button } = stage();
      focus(canvas, 'keyboard');
      focus(button('Outside'), 'keyboard');
      wait(IDLE_MS - 1);
      focus(canvas, 'keyboard');
      v.setAutoRotate.mockClear();
      wait(IDLE_MS);
      expect(v.setAutoRotate).not.toHaveBeenCalled();
    });

    it('holds still while a marker has keyboard focus, but not for other chrome', () => {
      const { v, canvas, focus, button } = stage();
      focus(button('Kitchen'), 'keyboard');
      expect(v.setAutoRotate).toHaveBeenLastCalledWith(false);
      // Tabbing on within the stage, to a control.
      focus(button('Zoom in'), 'keyboard');
      wait(IDLE_MS);
      expect(v.setAutoRotate).toHaveBeenLastCalledWith(true);
      focus(canvas, 'keyboard');
      expect(v.setAutoRotate).toHaveBeenLastCalledWith(false);
    });

    it("holds still while a point's panel has keyboard focus, as the marker hands it over", () => {
      const { v, focus, button } = stage();
      focus(button('Kitchen'), 'keyboard');
      v.setAutoRotate.mockClear();
      const panel = screen.getByRole('complementary', { name: 'Kitchen panel' });
      focus(panel, 'keyboard');
      wait(IDLE_MS);
      expect(v.setAutoRotate).not.toHaveBeenCalledWith(true);
      focus(screen.getByRole('link', { name: 'More' }), 'keyboard');
      wait(IDLE_MS);
      expect(v.setAutoRotate).not.toHaveBeenCalledWith(true);
    });

    it('lets go when the focused marker leaves the DOM without a blur', () => {
      const { v, focus, button, dropMarkers } = stage();
      focus(button('Kitchen'), 'keyboard');
      expect(v.setAutoRotate).toHaveBeenLastCalledWith(false);
      dropMarkers();
      expect(document.activeElement).toBe(document.body);
      wait(IDLE_MS);
      expect(v.setAutoRotate).toHaveBeenLastCalledWith(true);
    });

    it('keeps turning after a click or tap focuses the viewer', () => {
      const { v, canvas, focus } = stage();
      focus(canvas, 'pointer');
      expect(v.setAutoRotate).toHaveBeenLastCalledWith(true);
      expect(v.setAutoRotate).not.toHaveBeenCalledWith(false);
    });

    it('stays off when auto-rotate is off', () => {
      const { v, canvas, focus, button } = stage(false);
      focus(canvas, 'keyboard');
      focus(button('Outside'), 'keyboard');
      wait(IDLE_MS);
      expect(v.setAutoRotate).not.toHaveBeenCalledWith(true);
    });
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
    v.emit('scene-change', { id: 'hall', kind: 'tiles' });
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
    expect(f.last().load).toHaveBeenCalledWith('hall', { view: undefined });
  });

  it('builds the new viewer from the props of the render that changed baseUrl', () => {
    const f = factory();
    const stage = (baseUrl: string, label: string, north: number) => (
      <PanoStage
        baseUrl={baseUrl}
        panoId="hall"
        north={north}
        aria-label={label}
        createViewer={f.createViewer}
      />
    );
    const { rerender } = render(stage('a/', 'Town hall', 0.1));
    rerender(stage('b/', 'Town hall, new tiles', 0.7));
    expect(f.last().options.interaction?.label).toBe('Town hall, new tiles');
    expect(f.last().options.camera?.north).toBe(0.7);
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
    expect(live[0]?.load).toHaveBeenCalledWith('hall', { view: undefined });
    // The viewer the remount threw away never fetched anything.
    expect(f.made.flatMap((v) => v.calls)).toEqual(['load:hall']);
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
    expect(v.load).toHaveBeenLastCalledWith('hall', { view: undefined });
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
    expect(v.load).toHaveBeenLastCalledWith('hall', { view: undefined });
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
    expect(v.crossfade).not.toHaveBeenCalled();
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
    // The scene's view goes up with the preview, cut to rather than eased.
    expect(v.calls).toEqual(['show:hall', 'load:hall']);
    expect(v.setView).not.toHaveBeenCalled();
    expect(v.showPreview).toHaveBeenCalledWith('hall', sources[0], {
      replacesVersion: 'v1',
      view: { yaw: 1 },
    });
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
    const s = fakeSource();
    await act(async () => pending[0]?.resolve(s));
    expect(v.calls).toEqual(['show:hall', 'load:hall']);
    expect(v.showPreview).toHaveBeenCalledWith('hall', s, { view: { yaw: 1 } });

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
    expect(v.showPreview).toHaveBeenCalledTimes(1);
    expect(v.setView).not.toHaveBeenCalled();
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
    expect(v.calls).toEqual(['show:hall', 'load:hall', 'show:hall', 'load:hall']);
    expect(v.showPreview.mock.calls[0]![2]).toEqual({ view: { yaw: 1 } });
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
    expect(document.querySelector('.pn-stage__viewer')).toBeTruthy();
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

  it('empties the stage on a null panoId and drops the load still in flight', () => {
    const f = factory();
    const onSceneChange = vi.fn();
    const { container, rerender } = render(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        onSceneChange={onSceneChange}
        createViewer={f.createViewer}
      />,
    );
    const v = f.last();
    const host = container.querySelector<HTMLElement>('.pn-stage__viewer')!;
    expect(host.style.visibility).toBe('');
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId={null}
        onSceneChange={onSceneChange}
        createViewer={f.createViewer}
      />,
    );
    // Nothing is on stage, so the canvas is hidden (and out of Tab order).
    expect(host.style.visibility).toBe('hidden');
    // The hall load lands after the stage was emptied: stale, so not reported.
    v.emit('scene-change', { id: 'hall', kind: 'tiles' });
    expect(onSceneChange).not.toHaveBeenCalled();
    rerender(
      <PanoStage
        baseUrl="b/"
        panoId="hall"
        onSceneChange={onSceneChange}
        createViewer={f.createViewer}
      />,
    );
    expect(host.style.visibility).toBe('');
    expect(v.load).toHaveBeenCalledTimes(2);
    v.emit('scene-change', { id: 'hall', kind: 'tiles' });
    expect(onSceneChange).toHaveBeenCalledExactlyOnceWith('hall');
  });

  describe('without WebGL2', () => {
    it('says the view cannot be shown, as an alert, instead of crashing', () => {
      const createViewer = vi.fn((): PanoViewerApi => {
        throw new WebGLUnavailableError();
      });
      const onViewer = vi.fn();
      render(
        <PanoStage
          baseUrl="https://cdn.test/tiles/"
          panoId="hall"
          createViewer={createViewer}
          onViewer={onViewer}
        >
          <span>chrome</span>
        </PanoStage>,
      );
      expect(createViewer).toHaveBeenCalledTimes(1);
      // An alert, so it is announced as it appears: a status region is only
      // announced when content changes inside one already on the page.
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toBe('Your browser can’t display this 360° view.');
      expect(onViewer).not.toHaveBeenCalled();
    });

    it('still throws any other failure to build the viewer', () => {
      const createViewer = vi.fn((): PanoViewerApi => {
        throw new Error('boom');
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() =>
        render(
          <PanoStage baseUrl="https://cdn.test/tiles/" panoId="hall" createViewer={createViewer} />,
        ),
      ).toThrow('boom');
      vi.mocked(console.error).mockRestore();
    });

    it('says nothing on an empty stage, which is empty by design', () => {
      const createViewer = vi.fn((): PanoViewerApi => {
        throw new WebGLUnavailableError();
      });
      const { rerender } = render(
        <PanoStage baseUrl="https://cdn.test/tiles/" panoId={null} createViewer={createViewer} />,
      );
      expect(screen.queryByRole('alert')).toBeNull();
      rerender(
        <PanoStage baseUrl="https://cdn.test/tiles/" panoId="hall" createViewer={createViewer} />,
      );
      expect(screen.getByRole('alert').textContent).toBe(
        'Your browser can’t display this 360° view.',
      );
    });
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
      expect(v.load).toHaveBeenLastCalledWith('hall', { view: undefined });
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
      act(() => f.last().emit('load-error', { id: 'hall', error: lost }));
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
      act(() => v.emit('scene-change', { id: 'hall', kind: 'tiles' }));
      const err = new Error('manifest 500');
      v.crossfade.mockRejectedValueOnce(err);
      await act(async () => rerender(stage('nave')));
      expect(onLoadError).toHaveBeenCalledWith(err, 'nave');
      await act(async () => rerender(stage('hall', over.reloadKey)));
      return { v, rerender, stage };
    }

    it('does not reload the pano the viewer still has on screen', async () => {
      const { v, rerender, stage } = await failedHop();
      expect(v.crossfade.mock.calls.map((c) => c[0])).toEqual(['nave']);
      expect(v.calls).toEqual(['load:hall']);

      // It is the pano on stage again: the same link can be tried again.
      await act(async () => rerender(stage('nave')));
      expect(v.crossfade.mock.calls.map((c) => c[0])).toEqual(['nave', 'nave']);
    });

    it('reloads it when its reloadKey changed meanwhile', async () => {
      const { v } = await failedHop({ reloadKey: 'v2' });
      expect(v.crossfade.mock.calls.map((c) => c[0])).toEqual(['nave', 'hall']);
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
      act(() => v.emit('scene-change', { id: 'hall', kind: 'tiles' }));
      act(() => {
        v.emit('context-lost');
        v.emit('context-restored');
        v.emit('load-error', { id: 'hall', error: new Error('manifest 503') });
      });
      v.crossfade.mockRejectedValueOnce(new Error('manifest 500'));
      await act(async () => rerender(stage('nave')));
      await act(async () => rerender(stage('hall')));
      // Nothing of hall is on screen any more: it has to be loaded.
      expect(v.crossfade.mock.calls.map((c) => c[0])).toEqual(['nave', 'hall']);
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
        v.emit('scene-change', { id: pano, kind: 'tiles' });
      });
      v.load.mockRejectedValueOnce(new Error('manifest 404'));
      act(() => {
        v.emit('context-lost');
        v.emit('context-restored');
      });
      await act(async () => {});
      v.crossfade.mockRejectedValueOnce(new Error('manifest 500'));
      await act(async () => rerender(stage('nave')));
      await act(async () => rerender(stage('hall')));
      expect(v.calls.filter((c) => c === 'show:hall')).toHaveLength(3);
    });

    it('loads it when another pano landed while the stage was empty', async () => {
      const f = factory();
      const stage = (panoId: string | null) => (
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
      act(() => v.emit('scene-change', { id: 'hall', kind: 'tiles' }));
      rerender(stage('nave'));
      rerender(stage(null));
      // The hop lands on the empty stage: nave, not hall, is what the viewer has now.
      act(() => v.emit('scene-change', { id: 'nave', kind: 'tiles' }));
      v.load.mockRejectedValueOnce(new Error('manifest 500'));
      await act(async () => rerender(stage('crypt')));
      await act(async () => rerender(stage('hall')));
      const cuts = v.load.mock.calls.filter(([, opts]) => !opts?.transition);
      expect(cuts.map((c) => c[0])).toEqual(['hall', 'crypt']);
      expect(v.crossfade.mock.calls.map((c) => c[0])).toEqual(['nave', 'hall']);
    });

    it('cancels a change still in flight instead of reloading the pano on screen', async () => {
      const f = factory();
      const onLoadError = vi.fn();
      const stage = (panoId: string, reloadKey = 1) => (
        <PanoStage
          baseUrl="b/"
          panoId={panoId}
          reloadKey={reloadKey}
          transition
          onLoadError={onLoadError}
          createViewer={f.createViewer}
        />
      );
      const { rerender } = render(stage('hall'));
      const v = f.last();
      act(() => v.emit('scene-change', { id: 'hall', kind: 'tiles' }));
      let rejectHop!: (err: unknown) => void;
      v.crossfade.mockReturnValueOnce(new Promise((_, reject) => (rejectHop = reject)));
      rerender(stage('nave'));
      rerender(stage('hall'));
      // Hall never left the screen: the hop is dropped, and hall keeps its tiles
      // and camera rather than crossfading down to its base again.
      expect(v.crossfade.mock.calls.map((c) => c[0])).toEqual(['nave']);
      expect(v.calls).toEqual(['load:hall', 'cancel']);
      // The cancelled hop settling late is not reported.
      await act(async () => rejectHop(new Error('aborted')));
      expect(onLoadError).not.toHaveBeenCalled();
      // Hall is the pano on stage again: the same link can be tried again.
      rerender(stage('nave'));
      expect(v.crossfade.mock.calls.map((c) => c[0])).toEqual(['nave', 'nave']);
    });

    it('reloads the pano on screen, rather than cancel, when its reloadKey changed meanwhile', () => {
      const f = factory();
      const stage = (panoId: string, reloadKey: number) => (
        <PanoStage
          baseUrl="b/"
          panoId={panoId}
          reloadKey={reloadKey}
          transition
          createViewer={f.createViewer}
        />
      );
      const { rerender } = render(stage('hall', 1));
      const v = f.last();
      act(() => v.emit('scene-change', { id: 'hall', kind: 'tiles' }));
      v.crossfade.mockReturnValueOnce(new Promise(() => {}));
      rerender(stage('nave', 1));
      rerender(stage('hall', 2));
      expect(v.cancelLoad).not.toHaveBeenCalled();
      expect(v.crossfade.mock.calls.map((c) => c[0])).toEqual(['nave', 'hall']);
    });
  });
});
