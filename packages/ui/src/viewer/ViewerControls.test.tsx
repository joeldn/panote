import type { PanoViewer } from '@panote/viewer';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PanoViewerContext } from '../viewer-context.js';
import { ViewerControls } from './ViewerControls.js';

const viewer = { getView: () => ({ yaw: 0, pitch: 0, fov: 70 }), setView: vi.fn() };

function setFullscreenEnabled(value: boolean | undefined) {
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value });
}

function renderControls(target: HTMLElement) {
  render(
    <PanoViewerContext.Provider value={viewer as unknown as PanoViewer}>
      <ViewerControls fullscreenTarget={{ current: target }} />
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
