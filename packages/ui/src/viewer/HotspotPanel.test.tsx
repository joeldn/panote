import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { HotspotMarkers } from './HotspotMarkers.js';
import { HotspotPanel } from './HotspotPanel.js';
import type { ViewerHotspot } from './types.js';

const points: ViewerHotspot[] = [
  { id: 'a', yaw: 0, pitch: 0, title: 'Kitchen' },
  { id: 'b', yaw: 1, pitch: 0, title: 'Garden' },
];

// The real markers next to the panel, laid out as TourViewer does (no viewer needed).
function Harness() {
  const [active, setActive] = useState<ViewerHotspot | null>(null);
  return (
    <div>
      <button type="button">Elsewhere</button>
      <HotspotMarkers hotspots={points} activeId={active?.id ?? null} onOpen={setActive} />
      {active && <HotspotPanel hotspot={active} onClose={() => setActive(null)} />}
    </div>
  );
}

const markerOf = (name: string) => screen.getByRole('button', { name });

// Keyboard: the marker has focus when it's activated.
function openWith(name: string) {
  const marker = markerOf(name);
  marker.focus();
  fireEvent.click(marker);
  return marker;
}

// Safari and iOS don't focus a tapped button, so focus stays wherever it was.
function tap(name: string) {
  const marker = markerOf(name);
  fireEvent.click(marker);
  return marker;
}

afterEach(cleanup);

describe('HotspotPanel focus and Escape', () => {
  it('moves focus into the panel when it opens', () => {
    render(<Harness />);
    openWith('Kitchen');
    const panel = screen.getByRole('complementary', { name: 'Kitchen' });
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape and returns focus to the marker', () => {
    render(<Harness />);
    const marker = openWith('Kitchen');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(marker);
  });

  it('returns focus to the last marker used after switching points', () => {
    render(<Harness />);
    openWith('Kitchen');
    const garden = openWith('Garden');
    const panel = screen.getByRole('complementary', { name: 'Garden' });
    expect(panel.contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(garden);
  });

  it('returns focus to a tapped marker that never took focus', () => {
    render(<Harness />);
    const kitchen = tap('Kitchen');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(kitchen);
  });

  it('returns focus to the marker, not to whatever had focus before the tap', () => {
    render(<Harness />);
    markerOf('Elsewhere').focus();
    const garden = tap('Garden');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(garden);
  });

  it('ignores other keys', () => {
    render(<Harness />);
    openWith('Kitchen');
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(screen.getByRole('complementary', { name: 'Kitchen' })).toBeTruthy();
  });
});
