import type { PanoViewerApi } from '@panote/viewer';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Modal } from '../Modal.js';
import { PanoViewerContext } from '../viewer-context.js';
import {
  PSEUDO_FULLSCREEN_CLASS,
  ViewerControls,
  type ViewerControlsProps,
} from './ViewerControls.js';

const viewer = {
  getView: () => ({ yaw: 0, pitch: 0, fov: 70 }),
  setView: vi.fn(),
  zoomBy: vi.fn(),
};

function setFullscreenEnabled(value: boolean | undefined) {
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value });
}

function renderControls(target: HTMLElement, props: Partial<ViewerControlsProps> = {}) {
  render(
    <PanoViewerContext.Provider value={viewer as unknown as PanoViewerApi}>
      <ViewerControls fullscreenTarget={{ current: target }} {...props} />
    </PanoViewerContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'fullscreenEnabled');
});

describe('ViewerControls fullscreen', () => {
  it('hides the button when the document says fullscreen is not allowed', () => {
    // e.g. a third-party embed without allow="fullscreen".
    setFullscreenEnabled(false);
    const el = document.createElement('div');
    el.requestFullscreen = vi.fn(async () => {});
    renderControls(el);
    expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull();
  });

  it('hides the button when the target cannot go fullscreen (iPhone Safari)', () => {
    setFullscreenEnabled(undefined);
    renderControls(document.createElement('div'));
    expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull();
  });

  it('hides the button when fullscreen is enabled but the target has no requestFullscreen', () => {
    // e.g. a browser with only a prefixed API: the button would do nothing.
    setFullscreenEnabled(true);
    renderControls(document.createElement('div'));
    expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull();
  });

  it('swallows a rejected fullscreen request', async () => {
    setFullscreenEnabled(true);
    const el = document.createElement('div');
    const rejected = Promise.reject(new TypeError('Permissions check failed'));
    const caught = vi.spyOn(rejected, 'catch');
    el.requestFullscreen = vi.fn(() => rejected);
    renderControls(el);
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(el.requestFullscreen).toHaveBeenCalled();
    expect(caught).toHaveBeenCalled();
    await act(async () => {});
  });
});

describe('ViewerControls fullscreen fallback (iPhone Safari)', () => {
  it('pins the target over the viewport, and the same button leaves it', () => {
    setFullscreenEnabled(undefined);
    const el = document.createElement('div');
    renderControls(el, { fullscreenFallback: 'pseudo' });
    const button = screen.getByRole('button', { name: 'Fullscreen' });
    fireEvent.click(button);
    expect(el.classList.contains(PSEUDO_FULLSCREEN_CLASS)).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Exit fullscreen');
    expect(button.querySelector('i')?.className).toContain('fa-compress');
    fireEvent.click(button);
    expect(el.classList.contains(PSEUDO_FULLSCREEN_CLASS)).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Fullscreen');
  });

  it('leaves on Escape, and when unmounted', () => {
    setFullscreenEnabled(undefined);
    const el = document.createElement('div');
    renderControls(el, { fullscreenFallback: 'pseudo' });
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(el.classList.contains(PSEUDO_FULLSCREEN_CLASS)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(el.classList.contains(PSEUDO_FULLSCREEN_CLASS)).toBe(true);
    cleanup();
    expect(el.classList.contains(PSEUDO_FULLSCREEN_CLASS)).toBe(false);
  });

  it('stays pinned when Escape closes a dialog open over it', () => {
    setFullscreenEnabled(undefined);
    const el = document.createElement('div');
    const onClose = vi.fn();
    const { rerender } = render(
      <PanoViewerContext.Provider value={viewer as unknown as PanoViewerApi}>
        <ViewerControls fullscreenTarget={{ current: el }} fullscreenFallback="pseudo" />
      </PanoViewerContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    // The share sheet opens over it after it went fullscreen.
    rerender(
      <PanoViewerContext.Provider value={viewer as unknown as PanoViewerApi}>
        <ViewerControls fullscreenTarget={{ current: el }} fullscreenFallback="pseudo" />
        <Modal open onClose={onClose} aria-label="Share">
          <p>sheet</p>
        </Modal>
      </PanoViewerContext.Provider>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(el.classList.contains(PSEUDO_FULLSCREEN_CLASS)).toBe(true);
    // With the sheet gone, Escape leaves fullscreen.
    rerender(
      <PanoViewerContext.Provider value={viewer as unknown as PanoViewerApi}>
        <ViewerControls fullscreenTarget={{ current: el }} fullscreenFallback="pseudo" />
      </PanoViewerContext.Provider>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(el.classList.contains(PSEUDO_FULLSCREEN_CLASS)).toBe(false);
  });

  it('uses the real thing where the target can have it', () => {
    setFullscreenEnabled(true);
    const el = document.createElement('div');
    el.requestFullscreen = vi.fn(async () => {});
    renderControls(el, { fullscreenFallback: 'pseudo' });
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(el.requestFullscreen).toHaveBeenCalled();
    expect(el.classList.contains(PSEUDO_FULLSCREEN_CLASS)).toBe(false);
  });

  it('offers a link to open the page in a new tab instead (an embed)', () => {
    setFullscreenEnabled(false);
    renderControls(document.createElement('div'), {
      fullscreenFallback: { href: '/s/old-town?pano=hall' },
    });
    expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull();
    const link = screen.getByRole('link', { name: 'Open fullscreen in a new tab' });
    expect(link.getAttribute('href')).toBe('/s/old-town?pano=hall');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
  });

  it('offers no link where the target can go fullscreen itself', () => {
    setFullscreenEnabled(true);
    const el = document.createElement('div');
    el.requestFullscreen = vi.fn(async () => {});
    renderControls(el, { fullscreenFallback: { href: '/s/old-town' } });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeTruthy();
  });
});

describe('ViewerControls without a viewer', () => {
  it('disables the zoom buttons, which would do nothing', () => {
    render(
      <PanoViewerContext.Provider value={null}>
        <ViewerControls />
      </PanoViewerContext.Provider>,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Zoom in' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Zoom out' }).disabled).toBe(true);
  });
});
