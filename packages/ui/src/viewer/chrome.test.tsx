import type { PanoViewerApi } from '@panote/viewer';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PanoViewerContext } from '../viewer-context.js';
import { Compass } from './Compass.js';
import { FloorLinks } from './FloorLinks.js';
import { HotspotMarkers } from './HotspotMarkers.js';
import { HotspotPanel } from './HotspotPanel.js';
import { SceneMap } from './SceneMap.js';
import type { ViewerHotspot } from './types.js';
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
    requestRender: vi.fn(),
    focus: vi.fn(),
    getView: vi.fn(() => ({ yaw: 0, pitch: 0, fov: v.fov })),
    setView: vi.fn((view: { fov?: number }) => {
      if (view.fov !== undefined) v.fov = view.fov;
    }),
    zoomBy: vi.fn((factor: number) => {
      v.fov *= factor;
    }),
    frame: () => act(() => frames.forEach((cb) => cb())),
  };
  return v;
}

const withViewer = (viewer: ReturnType<typeof fakeViewer>, ui: ReactNode) =>
  render(
    <PanoViewerContext.Provider value={viewer as unknown as PanoViewerApi}>
      {ui}
    </PanoViewerContext.Provider>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Gives every element a laid-out size (jsdom has no layout, so it reads 0×0). */
function stageSize(width: number, height: number) {
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(width);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(height);
}

/** A ResizeObserver whose callback the test fires with a new size. */
function fakeResizeObserver() {
  const observers: { cb: ResizeObserverCallback; self: ResizeObserver }[] = [];
  class FakeResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      observers.push({ cb, self: this as unknown as ResizeObserver });
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return (width: number, height: number) =>
    act(() => {
      for (const { cb, self } of observers) {
        cb([{ contentRect: { width, height } } as ResizeObserverEntry], self);
      }
    });
}

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

  it('hides a marker whose point is in front of the camera but off the stage', () => {
    stageSize(800, 600);
    const v = fakeViewer();
    const spots = [
      { id: 'in', yaw: 1, pitch: 0.5, title: 'In view' },
      // Within the margin (about half a marker) past the right edge: partly visible.
      { id: 'edge', yaw: 8.1, pitch: 0, title: 'At the edge' },
      { id: 'right', yaw: 9, pitch: 0, title: 'Off to the right' },
      { id: 'below', yaw: 1, pitch: 7, title: 'Off below' },
      { id: 'above', yaw: 1, pitch: -1, title: 'Off above' },
      // A bigger marker reaches further, so its margin grows with it.
      { id: 'big', yaw: 8.5, pitch: 0, title: 'Big at the edge', size: 3 },
    ];
    withViewer(v, <HotspotMarkers hotspots={spots} onOpen={() => {}} />);
    v.frame();
    const vis = (title: string) =>
      document.querySelector(`[aria-label="${title}"]`)!.parentElement!.style.visibility;
    expect(vis('In view')).toBe('visible');
    expect(vis('At the edge')).toBe('visible');
    expect(vis('Off to the right')).toBe('hidden');
    expect(vis('Off below')).toBe('hidden');
    expect(vis('Off above')).toBe('hidden');
    expect(vis('Big at the edge')).toBe('visible');
    // Hidden markers drop out of the accessibility tree (and so of Tab order).
    expect(screen.queryByRole('button', { name: 'Off to the right' })).toBeNull();
    expect(screen.getByRole('button', { name: 'In view' })).toBeTruthy();
  });

  it('re-places markers when the stage is resized', () => {
    stageSize(800, 600);
    const resize = fakeResizeObserver();
    const v = fakeViewer();
    withViewer(
      v,
      <HotspotMarkers
        hotspots={[{ id: 'r', yaw: 9, pitch: 0, title: 'Right' }]}
        onOpen={() => {}}
      />,
    );
    v.frame();
    const anchor = document.querySelector('[aria-label="Right"]')!.parentElement!;
    expect(anchor.style.visibility).toBe('hidden');
    resize(1200, 600);
    expect(v.requestRender).toHaveBeenCalled();
    v.frame();
    expect(anchor.style.visibility).toBe('visible');
  });

  describe('focus on a marker that hides', () => {
    // Focused marker "a" at yaw 1; turning the camera puts it behind (negative yaw).
    function focusedMarker() {
      const v = fakeViewer();
      let yaw = 1;
      v.project.mockImplementation((_yaw: number, pitch: number) => ({
        x: yaw * 100,
        y: pitch * 100,
        behind: yaw < 0,
      }));
      withViewer(
        v,
        <HotspotMarkers
          hotspots={[{ id: 'a', yaw: 1, pitch: 0, title: 'Kitchen' }]}
          onOpen={() => {}}
        />,
      );
      v.frame();
      const marker = screen.getByRole('button', { name: 'Kitchen' });
      return { v, marker, turn: (to: number) => (yaw = to) };
    }

    it('hands focus to the viewer when the focused marker goes behind the camera', () => {
      const { v, marker, turn } = focusedMarker();
      marker.focus();
      turn(-1);
      v.frame();
      expect(marker.parentElement!.style.visibility).toBe('hidden');
      expect(v.focus).toHaveBeenCalledOnce();
    });

    it('hands focus to the viewer when the focused marker goes off the stage', () => {
      stageSize(800, 600);
      const { v, marker, turn } = focusedMarker();
      marker.focus();
      turn(9);
      v.frame();
      expect(marker.parentElement!.style.visibility).toBe('hidden');
      expect(v.focus).toHaveBeenCalledOnce();
    });

    it('leaves focus alone when the marker that hides is not focused', () => {
      const { v, marker, turn } = focusedMarker();
      turn(-1);
      v.frame();
      expect(marker.parentElement!.style.visibility).toBe('hidden');
      expect(v.focus).not.toHaveBeenCalled();
    });

    it('reads the focus only on frames where a marker shows or hides', () => {
      const { v, marker, turn } = focusedMarker();
      marker.focus();
      const active = vi.spyOn(document, 'activeElement', 'get');
      v.frame();
      v.frame();
      expect(active).not.toHaveBeenCalled();
      turn(-1);
      v.frame();
      v.frame();
      expect(active).toHaveBeenCalledOnce();
      expect(v.focus).toHaveBeenCalledOnce();
    });
  });

  it('groups the markers under one name', () => {
    withViewer(fakeViewer(), <HotspotMarkers hotspots={[]} onOpen={() => {}} />);
    expect(screen.getByRole('group', { name: 'Points of interest' })).toBeTruthy();
  });

  it('places a marker added to the list without waiting for a frame', () => {
    const v = fakeViewer();
    const a = { id: 'a', yaw: 1, pitch: 0, title: 'Kitchen' };
    const { rerender } = withViewer(v, <HotspotMarkers hotspots={[a]} onOpen={() => {}} />);
    const b = { id: 'b', yaw: 0.5, pitch: 0.2, title: 'Hall' };
    // An idle viewer draws no frame, so nothing else would place the new marker.
    rerender(
      <PanoViewerContext.Provider value={v as unknown as PanoViewerApi}>
        <HotspotMarkers hotspots={[a, b]} onOpen={() => {}} />
      </PanoViewerContext.Provider>,
    );
    const anchor = screen.getByRole('button', { name: 'Hall' }).parentElement!;
    expect(anchor.style.visibility).toBe('visible');
    expect(anchor.style.transform).toBe('translate(50px, 20px)');
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

  it('hides a chevron whose far point is behind the camera, even with the near one in front', () => {
    const v = fakeViewer();
    // Pitched down: the near floor point (-0.6) is in front, the far one (-0.2) behind.
    v.project.mockImplementation((yaw: number, pitch: number) => ({
      x: yaw * 100,
      y: pitch * 100,
      behind: pitch > -0.4,
    }));
    withViewer(v, <FloorLinks links={[{ to: 'hall', yaw: 1, label: 'Hall' }]} onGo={() => {}} />);
    v.frame();
    const anchor = document.querySelector('[aria-label="Go to Hall"]')!.parentElement!;
    expect(anchor.style.visibility).toBe('hidden');
  });

  it('hides a chevron whose points are in front of the camera but off the stage', () => {
    stageSize(800, 600);
    const v = fakeViewer();
    withViewer(
      v,
      <FloorLinks
        links={[
          { to: 'hall', yaw: 1, label: 'Hall' },
          { to: 'yard', yaw: 10, label: 'Yard' },
        ]}
        onGo={() => {}}
      />,
    );
    v.frame();
    const vis = (label: string) =>
      document.querySelector(`[aria-label="Go to ${label}"]`)!.parentElement!.style.visibility;
    expect(vis('Hall')).toBe('visible');
    expect(vis('Yard')).toBe('hidden');
    expect(screen.queryByRole('button', { name: 'Go to Yard' })).toBeNull();
  });

  it('hands focus to the viewer when the focused chevron goes behind the camera, once', () => {
    const v = fakeViewer();
    withViewer(v, <FloorLinks links={[{ to: 'hall', yaw: 1, label: 'Hall' }]} onGo={() => {}} />);
    v.frame();
    const chevron = screen.getByRole('button', { name: 'Go to Hall' });
    chevron.focus();
    const active = vi.spyOn(document, 'activeElement', 'get');
    v.frame();
    expect(active).not.toHaveBeenCalled();
    v.project.mockImplementation((yaw: number, pitch: number) => ({
      x: yaw * 100,
      y: pitch * 100,
      behind: true,
    }));
    v.frame();
    v.frame();
    expect(chevron.parentElement!.style.visibility).toBe('hidden');
    expect(v.focus).toHaveBeenCalledOnce();
    expect(active).toHaveBeenCalledOnce();
  });

  it('keeps a chevron about 47 px past the edge, its widened near end, on stage', () => {
    stageSize(800, 600);
    const v = fakeViewer();
    // The chevron's centre lands 47 px right of the stage's right edge.
    v.project.mockImplementation((yaw: number, pitch: number) => ({
      x: yaw,
      y: 300 + pitch * 100,
      behind: false,
    }));
    withViewer(
      v,
      <FloorLinks
        links={[
          { to: 'hall', yaw: 847, label: 'Hall' },
          { to: 'yard', yaw: 860, label: 'Yard' },
        ]}
        onGo={() => {}}
      />,
    );
    v.frame();
    const vis = (label: string) =>
      document.querySelector(`[aria-label="Go to ${label}"]`)!.parentElement!.style.visibility;
    expect(vis('Hall')).toBe('visible');
    expect(vis('Yard')).toBe('hidden');
  });

  it('groups the chevrons under one name', () => {
    withViewer(fakeViewer(), <FloorLinks links={[]} onGo={() => {}} />);
    expect(screen.getByRole('group', { name: 'Go to' })).toBeTruthy();
  });

  it('places a chevron added to the list without waiting for a frame', () => {
    const v = fakeViewer();
    const hall = { to: 'hall', yaw: 1, label: 'Hall' };
    const { rerender } = withViewer(v, <FloorLinks links={[hall]} onGo={() => {}} />);
    rerender(
      <PanoViewerContext.Provider value={v as unknown as PanoViewerApi}>
        <FloorLinks links={[hall, { to: 'yard', yaw: 2, label: 'Yard' }]} onGo={() => {}} />
      </PanoViewerContext.Provider>,
    );
    const anchor = screen.getByRole('button', { name: 'Go to Yard' }).parentElement!;
    expect(anchor.style.visibility).toBe('visible');
    expect(anchor.style.transform).toMatch(/^translate\(200px, -40px\) rotate/);
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
    // Through zoomBy, which steps from the fov on screen: scaling
    // getView().fov can sit above what a wide viewport draws.
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(v.zoomBy).toHaveBeenLastCalledWith(0.8);
    expect(v.fov).toBeCloseTo(56);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(v.zoomBy).toHaveBeenLastCalledWith(1.25);
    expect(v.fov).toBeCloseTo(70);
    expect(v.setView).not.toHaveBeenCalled();
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

  it('hands focus to the viewer on close when its marker is now hidden', () => {
    const v = fakeViewer();
    let yaw = 1;
    v.project.mockImplementation((_yaw: number, pitch: number) => ({
      x: yaw * 100,
      y: pitch * 100,
      behind: yaw < 0,
    }));
    function Points() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <HotspotMarkers
            hotspots={[base]}
            activeId={open ? 'a' : null}
            onOpen={() => setOpen(true)}
          />
          {open && <HotspotPanel hotspot={base} onClose={() => setOpen(false)} />}
        </>
      );
    }
    withViewer(v, <Points />);
    v.frame();
    fireEvent.click(screen.getByRole('button', { name: 'Kitchen' }));
    // The camera turns away while the panel is open: the marker is behind it now.
    yaw = -1;
    v.frame();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(v.focus).toHaveBeenCalledOnce();
  });

  it('hands focus back to its marker on close while the marker is on stage', () => {
    const v = fakeViewer();
    function Points() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <HotspotMarkers
            hotspots={[base]}
            activeId={open ? 'a' : null}
            onOpen={() => setOpen(true)}
          />
          {open && <HotspotPanel hotspot={base} onClose={() => setOpen(false)} />}
        </>
      );
    }
    withViewer(v, <Points />);
    v.frame();
    const marker = screen.getByRole('button', { name: 'Kitchen' });
    fireEvent.click(marker);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(marker);
    expect(v.focus).not.toHaveBeenCalled();
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

  it.each([
    { kind: 'youtube', id: 'dQw4w9WgXcQ' },
    { kind: 'vimeo', id: '76979871' },
  ] as const)('sandboxes the $kind player, keeping fullscreen', (media) => {
    panel(media);
    const frame = screen.getByTitle('Kitchen');
    const flags = frame.getAttribute('sandbox')!.split(' ').sort();
    expect(flags).toEqual([
      'allow-forms',
      'allow-popups',
      'allow-popups-to-escape-sandbox',
      'allow-presentation',
      'allow-same-origin',
      'allow-scripts',
    ]);
    expect(frame.getAttribute('allow')).toContain('fullscreen');
  });

  const panel = (media: NonNullable<ViewerHotspot['media']>, id = 'a') =>
    render(<HotspotPanel hotspot={{ ...base, id, media }} onClose={() => {}} />);

  it('embeds Vimeo through its do-not-track player, with the unlisted hash', () => {
    panel({ kind: 'vimeo', id: '76979871', hash: '8272103f6e' });
    const frame = screen.getByTitle('Kitchen');
    expect(frame.getAttribute('src')).toBe(
      'https://player.vimeo.com/video/76979871?dnt=1&h=8272103f6e',
    );
    expect(frame.getAttribute('loading')).toBe('lazy');
    // No autoplay: neither the player url nor the frame's permissions ask for it.
    expect(frame.getAttribute('allow')).not.toContain('autoplay');
    expect(frame.getAttribute('src')).not.toContain('autoplay');
  });

  it('renders linked image, audio and video inline from any https host, without autoplay', () => {
    const { container } = panel({ kind: 'image', url: 'https://images.example/a.jpg' });
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://images.example/a.jpg');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img.getAttribute('loading')).toBe('lazy');
    cleanup();

    const audio = panel({
      kind: 'audio',
      url: 'https://sounds.example/a.mp3',
    }).container.querySelector('audio')!;
    expect(audio.getAttribute('src')).toBe('https://sounds.example/a.mp3');
    expect(audio.hasAttribute('controls')).toBe(true);
    expect(audio.hasAttribute('autoplay')).toBe(false);
    cleanup();

    const video = panel({
      kind: 'video',
      url: 'https://clips.example/a.mp4',
    }).container.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('https://clips.example/a.mp4');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.hasAttribute('autoplay')).toBe(false);
  });

  it('renders a link media as an external link to its host', () => {
    const { container } = panel({ kind: 'link', url: 'https://example.org/history' });
    const link = screen.getByRole('link', { name: 'Visit example.org ↗' });
    expect(link.getAttribute('href')).toBe('https://example.org/history');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('nofollow ugc noopener noreferrer');
    expect(container.querySelector('img, audio, video, iframe')).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'http://example.org/a',
    'https://user:pass@example.org/a',
    'https://user@example.org/a',
    'https://',
  ])('renders nothing for a url %j that is not plain https', (url) => {
    for (const kind of ['image', 'audio', 'video', 'link'] as const) {
      const { container } = panel({ kind, url });
      expect(container.querySelector('a, img, audio, video')).toBeNull();
      cleanup();
    }
  });

  it.each([
    ['image', 'img', 'Open image ↗'],
    ['audio', 'audio', 'Open audio ↗'],
    ['video', 'video', 'Open video ↗'],
  ] as const)('falls back to a link when %s media fails to load', (kind, tag, label) => {
    const url = `https://elsewhere.test/a.${tag}`;
    const { container } = panel({ kind, url });
    fireEvent.error(container.querySelector(tag)!);
    expect(container.querySelector('img, audio, video')).toBeNull();
    const link = screen.getByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe(url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('nofollow ugc noopener noreferrer');
  });
});

describe('SceneMap', () => {
  const list = () => within(document.querySelector('.pn-scenemap__list') as HTMLElement);
  const plan = () => within(screen.getByRole('group', { name: 'Floor plan' }));

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
    expect(list().getByRole('button', { name: 'Hall' }).getAttribute('aria-current')).toBe(
      'location',
    );
    fireEvent.click(list().getByRole('button', { name: 'Kitchen' }));
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('button', { name: 'Kitchen' })).toBeNull();
  });

  it('makes each dot a button named after its scene that goes there', () => {
    const onSelect = vi.fn();
    render(
      <SceneMap
        scenes={[
          { id: 'a', title: 'Hall', x: 0.1, y: 0.2 },
          { id: 'b', title: 'Kitchen', x: 0.75, y: 0.5 },
          { id: 'c', title: 'Garden' },
        ]}
        current="a"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const dots = plan().getAllByRole('button');
    expect(dots.map((d) => d.getAttribute('aria-label'))).toEqual(['Hall', 'Kitchen']);
    // 0..1 positions are fractions of the plan, as they are.
    expect(dots[1]!.style.left).toBe('75%');
    expect(dots[1]!.style.top).toBe('50%');
    expect(dots[0]!.getAttribute('aria-current')).toBe('location');
    expect(dots[0]!.className).toContain('pn-scenemap__dot--on');
    expect(dots[1]!.getAttribute('aria-current')).toBeNull();
    fireEvent.click(dots[1]!);
    expect(onSelect).toHaveBeenCalledWith('b');
    // The list stays, with every scene, placed or not.
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(list().getAllByRole('button')).toHaveLength(3);
  });

  it('fits older, unit-free positions into the plan as before', () => {
    render(
      <SceneMap
        scenes={[
          { id: 'a', title: 'Hall', x: 0, y: 0 },
          { id: 'b', title: 'Kitchen', x: 10, y: 5 },
        ]}
        current="a"
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const [hall, kitchen] = plan().getAllByRole('button');
    expect(hall!.style.left).toBe('8%');
    expect(parseFloat(kitchen!.style.left)).toBeCloseTo(92);
  });

  it('shows no plan without positions, and one dot only over a plan image', () => {
    const scenes = [
      { id: 'a', title: 'Hall', x: 0.5, y: 0.5 },
      { id: 'b', title: 'Kitchen' },
    ];
    const { rerender, container } = render(
      <SceneMap
        scenes={scenes.map(({ id, title }) => ({ id, title }))}
        current="a"
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(screen.queryByRole('group', { name: 'Floor plan' })).toBeNull();
    rerender(<SceneMap scenes={scenes} current="a" onSelect={() => {}} />);
    expect(screen.queryByRole('group', { name: 'Floor plan' })).toBeNull();
    rerender(
      <SceneMap
        scenes={scenes}
        current="a"
        plan={{ url: 'https://cdn.test/pub/plans/t/p.webp', width: 400, height: 200 }}
        onSelect={() => {}}
      />,
    );
    const group = screen.getByRole('group', { name: 'Floor plan' });
    expect(group.style.getPropertyValue('--pn-plan-ratio')).toBe('2');
    const img = container.querySelector('.pn-scenemap__img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://cdn.test/pub/plans/t/p.webp');
    expect(img.getAttribute('alt')).toBe('');
    expect(plan().getAllByRole('button')).toHaveLength(1);
  });

  it('turns a facing cone on the current dot with the view, only where north is set', () => {
    const viewer = fakeViewer();
    const scenes = [
      { id: 'a', title: 'Hall', x: 0.2, y: 0.2, hasNorth: true },
      { id: 'b', title: 'Kitchen', x: 0.8, y: 0.8, hasNorth: true },
    ];
    const { container, rerender } = withViewer(
      viewer,
      <SceneMap scenes={scenes} current="a" onSelect={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const cones = () => container.querySelectorAll<HTMLElement>('.pn-scenemap__facing');
    expect(cones()).toHaveLength(1);
    const hall = plan().getByRole('button', { name: 'Hall' });
    expect(hall.contains(cones()[0]!)).toBe(true);
    // heading() is north relative to the view (0.5 rad): the view faces -0.5 rad from north.
    expect(cones()[0]!.style.transform).toBe('rotate(-0.5rad)');
    viewer.heading.mockReturnValue(-1);
    viewer.frame();
    expect(cones()[0]!.style.transform).toBe('rotate(1rad)');
    // No north set: nothing to say which way is which.
    rerender(
      <PanoViewerContext.Provider value={viewer as unknown as PanoViewerApi}>
        <SceneMap
          scenes={scenes.map((s) => ({ ...s, hasNorth: false }))}
          current="a"
          onSelect={() => {}}
        />
      </PanoViewerContext.Provider>,
    );
    expect(cones()).toHaveLength(0);
  });

  it('while a change is pending, goes back to the scene on screen but not to the pending one', () => {
    const onSelect = vi.fn();
    const scenes = [
      { id: 'a', title: 'Hall' },
      { id: 'b', title: 'Kitchen' },
    ];
    render(<SceneMap scenes={scenes} current="a" pending="b" onSelect={onSelect} />);
    const pick = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Map' }));
      fireEvent.click(screen.getByRole('button', { name }));
    };
    pick('Kitchen, loading');
    expect(onSelect).not.toHaveBeenCalled();
    pick('Hall');
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('marks the pending scene busy, with a spinner and a spoken "loading"', () => {
    const scenes = [
      { id: 'a', title: 'Hall' },
      { id: 'b', title: 'Kitchen' },
    ];
    const { rerender } = render(
      <SceneMap scenes={scenes} current="a" pending="b" onSelect={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const kitchen = screen.getByRole('button', { name: 'Kitchen, loading' });
    expect(kitchen.getAttribute('aria-busy')).toBe('true');
    expect(kitchen.className).toContain('pn-scenemap__item--pending');
    expect(kitchen.querySelector('.pn-scenemap__spinner')).not.toBeNull();
    expect(list().getByRole('button', { name: 'Hall' }).getAttribute('aria-busy')).toBeNull();

    // Landed: no longer pending.
    rerender(<SceneMap scenes={scenes} current="b" onSelect={() => {}} />);
    const landed = screen.getByRole('button', { name: 'Kitchen' });
    expect(landed.getAttribute('aria-busy')).toBeNull();
    expect(landed.className).not.toContain('pn-scenemap__item--pending');
  });

  it('never points the toggle at a panel that is not there', () => {
    render(<SceneMap scenes={[{ id: 'a', title: 'Hall' }]} current="a" onSelect={() => {}} />);
    const toggle = screen.getByRole('button', { name: 'Map' });
    const controlled = () => {
      const id = toggle.getAttribute('aria-controls');
      return id === null ? null : document.getElementById(id);
    };
    expect(toggle.getAttribute('aria-controls')).toBeNull();
    fireEvent.click(toggle);
    expect(controlled()?.className).toBe('pn-scenemap__panel');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-controls')).toBeNull();
  });
});
