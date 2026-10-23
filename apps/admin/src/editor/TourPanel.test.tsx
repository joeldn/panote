import type { TourWithConfigsOk } from '@internal/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromServer } from './model.js';
import { dropIndex, keyMoveIndex } from './scene-order.js';
import { TourPanel, type TourPanelProps } from './TourPanel.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const server: TourWithConfigsOk = {
  tour: {
    tourId: 't1',
    title: 'Old town',
    scenes: [{ panoId: 'a' }, { panoId: 'b' }, { panoId: 'c' }],
  },
  etag: 'te',
  publish: null,
  configs: {
    a: { config: { panoId: 'a', title: 'Square', hotspots: [] }, etag: 'ea' },
    b: { config: { panoId: 'b', title: 'Church', hotspots: [] }, etag: 'eb' },
    c: { config: { panoId: 'c', title: 'Hall', hotspots: [] }, etag: 'ec' },
  },
};

function setup(over: Partial<TourPanelProps> = {}, withMove = true) {
  const props: TourPanelProps = {
    docs: fromServer(server),
    currentId: 'a',
    startId: null,
    dirty: false,
    onSelect: vi.fn(),
    onSetStart: vi.fn(),
    onRemove: vi.fn(),
    ...(withMove && { onMove: vi.fn() }),
    onAim: vi.fn(),
    onNudge: vi.fn(),
    onDisconnect: vi.fn(),
    onAddPano: vi.fn(),
    ...over,
  };
  render(
    <MemoryRouter>
      <TourPanel {...props} />
    </MemoryRouter>,
  );
  return props;
}

/** jsdom has no layout: rows 40px tall, stacked from y = 0 (middles at 20, 60, 100). */
const layout = () =>
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const rows = [...document.querySelectorAll('[data-scene]')];
    const i = Math.max(0, rows.indexOf(this));
    return {
      top: i * 40,
      height: 40,
      bottom: i * 40 + 40,
      left: 0,
      right: 300,
      width: 300,
    } as DOMRect;
  });

const handle = (name: string) => screen.getByRole('button', { name: new RegExp(`^Move ${name},`) });

describe('scene order helpers', () => {
  it('drops a row after every other row whose middle is above the pointer', () => {
    const mids = [20, 60, 100];
    expect(dropIndex(mids, 5, 2)).toBe(0);
    expect(dropIndex(mids, 70, 0)).toBe(1);
    expect(dropIndex(mids, 200, 0)).toBe(2);
    expect(dropIndex(mids, 30, 0)).toBe(0);
  });

  it('moves a row by arrow keys, Home and End, and not past either end', () => {
    expect(keyMoveIndex('ArrowUp', 2, 3)).toBe(1);
    expect(keyMoveIndex('ArrowDown', 0, 3)).toBe(1);
    expect(keyMoveIndex('Home', 2, 3)).toBe(0);
    expect(keyMoveIndex('End', 0, 3)).toBe(2);
    expect(keyMoveIndex('ArrowUp', 0, 3)).toBeNull();
    expect(keyMoveIndex('ArrowDown', 2, 3)).toBeNull();
    expect(keyMoveIndex('Enter', 1, 3)).toBeNull();
  });
});

describe('TourPanel: reordering', () => {
  it('drags a pano by its handle, with a mouse or a finger, and drops it where it is let go', () => {
    layout();
    const { onMove } = setup();
    const grip = handle('Hall');
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientY: 100 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 10 });
    // A line shows where it would land before it is let go.
    expect(document.querySelector('[data-scene="a"]')?.className).toContain(
      'ed-scene--drop-before',
    );
    expect(document.querySelector('[data-scene="c"]')?.className).toContain('ed-scene--dragging');
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 10 });
    expect(onMove).toHaveBeenCalledWith('c', 0);
    expect(document.querySelector('.ed-scene--dragging')).toBeNull();
  });

  it('a press without a move, or a cancelled drag, changes nothing', () => {
    layout();
    const { onMove } = setup();
    const grip = handle('Square');
    fireEvent.pointerDown(grip, { pointerId: 2, button: 0, clientY: 20 });
    fireEvent.pointerUp(grip, { pointerId: 2, clientY: 22 });
    fireEvent.pointerDown(grip, { pointerId: 3, button: 0, clientY: 20 });
    fireEvent.pointerMove(grip, { pointerId: 3, clientY: 90 });
    fireEvent.pointerCancel(grip, { pointerId: 3 });
    expect(onMove).not.toHaveBeenCalled();
    expect(document.querySelector('.ed-scene--dragging')).toBeNull();
  });

  it('moves a pano from the keyboard and says where it went', () => {
    const { onMove } = setup();
    fireEvent.keyDown(handle('Square'), { key: 'ArrowDown' });
    expect(onMove).toHaveBeenCalledWith('a', 1);
    expect(screen.getByText('Square moved to position 2 of 3.')).toBeTruthy();
    fireEvent.keyDown(handle('Square'), { key: 'ArrowUp' });
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it('has no handles with a single pano or without a move handler', () => {
    setup({}, false);
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
    cleanup();
    setup({
      docs: fromServer({ ...server, tour: { ...server.tour, scenes: [{ panoId: 'a' }] } }),
    });
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
  });
});
