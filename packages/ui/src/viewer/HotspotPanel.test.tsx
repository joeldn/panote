import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { HotspotPanel } from './HotspotPanel.js';
import type { ViewerHotspot } from './types.js';

const points: ViewerHotspot[] = [
  { id: 'a', yaw: 0, pitch: 0, title: 'Kitchen' },
  { id: 'b', yaw: 1, pitch: 0, title: 'Garden' },
];

// Stand-in for TourViewer's markers: each opens its point, focus stays where the click left it.
function Harness() {
  const [active, setActive] = useState<ViewerHotspot | null>(null);
  return (
    <>
      {points.map((p) => (
        <button key={p.id} type="button" onClick={() => setActive(p)}>
          {`Marker ${p.title}`}
        </button>
      ))}
      {active && <HotspotPanel hotspot={active} onClose={() => setActive(null)} />}
    </>
  );
}

function openWith(name: string) {
  const marker = screen.getByRole('button', { name });
  marker.focus();
  fireEvent.click(marker);
  return marker;
}

afterEach(cleanup);

describe('HotspotPanel focus and Escape', () => {
  it('moves focus into the panel when it opens', () => {
    render(<Harness />);
    openWith('Marker Kitchen');
    const panel = screen.getByRole('complementary', { name: 'Kitchen' });
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape and returns focus to the marker', () => {
    render(<Harness />);
    const marker = openWith('Marker Kitchen');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(marker);
  });

  it('returns focus to the last marker used after switching points', () => {
    render(<Harness />);
    openWith('Marker Kitchen');
    const garden = openWith('Marker Garden');
    const panel = screen.getByRole('complementary', { name: 'Garden' });
    expect(panel.contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(garden);
  });

  it('ignores other keys', () => {
    render(<Harness />);
    openWith('Marker Kitchen');
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(screen.getByRole('complementary', { name: 'Kitchen' })).toBeTruthy();
  });
});
