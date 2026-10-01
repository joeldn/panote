import type { PanoViewer } from '@panote/viewer';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PanoViewerContext } from '../viewer-context.js';
import { Compass } from './Compass.js';
import { FloorLinks } from './FloorLinks.js';
import { HotspotMarkers } from './HotspotMarkers.js';
import { HotspotPanel } from './HotspotPanel.js';
import { SceneMap } from './SceneMap.js';
import { ViewerControls } from './ViewerControls.js';

function fakeViewer() {
  const frames = new Set<() => void>();
  const v = {
    fov: 70,
    onRender: vi.fn((cb: () => void) => {
      frames.add(cb);
      return () => frames.delete(cb);
    }),
    // Points with negative yaw are "behind"; x/y just echo the angles.
    project: vi.fn((yaw: number, pitch: number) => ({
      x: yaw * 100,
      y: pitch * 100,
      behind: yaw < 0,
    })),
    heading: vi.fn(() => 0.5),
    getView: vi.fn(() => ({ yaw: 0, pitch: 0, fov: v.fov })),
    setView: vi.fn((view: { fov?: number }) => {
      if (view.fov !== undefined) v.fov = view.fov;
    }),
    frame: () => act(() => frames.forEach((cb) => cb())),
  };
  return v;
}

const withViewer = (viewer: ReturnType<typeof fakeViewer>, ui: ReactNode) =>
  render(
    <PanoViewerContext.Provider value={viewer as unknown as PanoViewer}>
      {ui}
    </PanoViewerContext.Provider>,
  );

afterEach(cleanup);

describe('HotspotMarkers', () => {
  it('pins each marker to its projection, hides it behind the camera, and opens on click', () => {
    const v = fakeViewer();
    const onOpen = vi.fn();
    const spots = [
      { id: 'a', yaw: 1, pitch: 0.5, title: 'Kitchen', icon: 'utensils', size: 2 },
      { id: 'b', yaw: -1, pitch: 0, title: 'Hall' },
    ];
    withViewer(v, <HotspotMarkers hotspots={spots} onOpen={onOpen} />);
    v.frame();
    const kitchen = screen.getByRole('button', { name: 'Kitchen' });
    const anchor = kitchen.parentElement!;
    expect(anchor.style.transform).toBe('translate(100px, 50px)');
    expect(anchor.style.visibility).toBe('visible');
    expect(document.querySelector('[aria-label="Hall"]')!.parentElement!.style.visibility).toBe(
      'hidden',
    );
    expect(kitchen.querySelector('i')!.className).toBe('fa-solid fa-utensils');
    expect(kitchen.style.getPropertyValue('--pn-hs-scale')).toBe('2');
    fireEvent.click(kitchen);
    expect(onOpen).toHaveBeenCalledWith(spots[0]);
  });
});

describe('FloorLinks', () => {
  it('lays a chevron along each link and navigates on click', () => {
    const v = fakeViewer();
    const onGo = vi.fn();
    const link = { to: 'hall', yaw: 1, label: 'Hall' };
    withViewer(v, <FloorLinks links={[link]} onGo={onGo} />);
    v.frame();
    const btn = screen.getByRole('button', { name: 'Go to Hall' });
    expect(btn.parentElement!.style.transform).toMatch(
      /^translate\(100px, -40px\) rotate\(.+rad\) scale\(.+\)$/,
    );
    fireEvent.click(btn);
    expect(onGo).toHaveBeenCalledWith(link);
  });
});

describe('Compass', () => {
  it('turns the needle by the viewer heading', () => {
    const v = fakeViewer();
    withViewer(v, <Compass />);
    v.frame();
    const needle = screen.getByRole('img', { name: 'Compass' }).firstElementChild as HTMLElement;
    expect(needle.style.transform).toBe('rotate(0.5rad)');
  });
});

describe('ViewerControls', () => {
  it('zooms in and out and toggles auto-rotate', () => {
    const v = fakeViewer();
    const onAuto = vi.fn();
    withViewer(v, <ViewerControls autoRotate={false} onAutoRotateChange={onAuto} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(v.fov).toBeCloseTo(56);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(v.fov).toBeCloseTo(70);
    fireEvent.click(screen.getByRole('button', { name: 'Auto-rotate' }));
    expect(onAuto).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull();
  });

  it('requests fullscreen on the target', () => {
    const v = fakeViewer();
    const el = document.createElement('div');
    el.requestFullscreen = vi.fn(async () => {});
    withViewer(v, <ViewerControls fullscreenTarget={{ current: el }} position="top" />);
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(el.requestFullscreen).toHaveBeenCalled();
    expect(screen.getByRole('toolbar').className).toContain('pn-controls--top');
  });
});

describe('HotspotPanel', () => {
  const base = { id: 'a', yaw: 0, pitch: 0, title: 'Kitchen' };

  it('renders escaped markdown and closes', () => {
    const onClose = vi.fn();
    render(
      <HotspotPanel hotspot={{ ...base, body: '**Bold** <script>x</script>' }} onClose={onClose} />,
    );
    const panel = screen.getByRole('complementary', { name: 'Kitchen' });
    expect(panel.querySelector('strong')!.textContent).toBe('Bold');
    expect(panel.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('embeds YouTube via youtube-nocookie', () => {
    render(
      <HotspotPanel
        hotspot={{ ...base, media: { kind: 'youtube', id: 'dQw4w9WgXcQ' } }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTitle('Kitchen').getAttribute('src')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
  });

  const cdnOnly = (url: string) => new URL(url).origin === 'https://cdn.test';

  it('renders CDN image and video media inline', () => {
    const { container, rerender } = render(
      <HotspotPanel
        hotspot={{ ...base, media: { kind: 'image', url: 'https://cdn.test/a.jpg' } }}
        onClose={() => {}}
        isAllowedMediaUrl={cdnOnly}
      />,
    );
    expect(container.querySelector('img')!.getAttribute('src')).toBe('https://cdn.test/a.jpg');
    rerender(
      <HotspotPanel
        hotspot={{ ...base, id: 'b', media: { kind: 'video', url: 'https://cdn.test/a.mp4' } }}
        onClose={() => {}}
        isAllowedMediaUrl={cdnOnly}
      />,
    );
    expect(container.querySelector('video')!.getAttribute('src')).toBe('https://cdn.test/a.mp4');
  });

  it.each([
    ['image', 'Open image ↗'],
    ['video', 'Open video ↗'],
  ] as const)('links %s media from another origin instead of loading it', (kind, label) => {
    const url = `https://elsewhere.test/a.${kind === 'image' ? 'jpg' : 'mp4'}`;
    const { container } = render(
      <HotspotPanel
        hotspot={{ ...base, media: { kind, url } }}
        onClose={() => {}}
        isAllowedMediaUrl={cdnOnly}
      />,
    );
    expect(container.querySelector('img, video')).toBeNull();
    const link = screen.getByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe(url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('links media by default, when no origin is allowed', () => {
    render(
      <HotspotPanel
        hotspot={{ ...base, media: { kind: 'image', url: 'https://cdn.test/a.jpg' } }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('link', { name: 'Open image ↗' })).toBeTruthy();
  });

  it.each(['image', 'video'] as const)(
    'falls back to a link when %s media fails to load',
    (kind) => {
      const url = `https://cdn.test/a.${kind === 'image' ? 'jpg' : 'mp4'}`;
      const { container } = render(
        <HotspotPanel
          hotspot={{ ...base, media: { kind, url } }}
          onClose={() => {}}
          isAllowedMediaUrl={cdnOnly}
        />,
      );
      fireEvent.error(container.querySelector(kind === 'image' ? 'img' : 'video')!);
      expect(container.querySelector('img, video')).toBeNull();
      expect(screen.getByRole('link', { name: /^Open / }).getAttribute('href')).toBe(url);
    },
  );
});

describe('SceneMap', () => {
  it('lists scenes, plots placed ones, and selects another scene', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <SceneMap
        scenes={[
          { id: 'a', title: 'Hall', x: 0, y: 0 },
          { id: 'b', title: 'Kitchen', x: 10, y: 5 },
        ]}
        current="a"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(container.querySelectorAll('.pn-scenemap__dot')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Hall' }).getAttribute('aria-current')).toBe(
      'location',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kitchen' }));
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('button', { name: 'Kitchen' })).toBeNull();
  });
});
