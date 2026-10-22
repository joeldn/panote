import type { TourWithConfigsOk } from '@internal/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapPanel, type MapPanelProps } from './MapPanel.js';
import { fromServer } from './model.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const server = (scenes: TourWithConfigsOk['tour']['scenes']): TourWithConfigsOk => ({
  tour: { tourId: 't1', title: 'Old town', scenes },
  etag: 'te',
  publish: null,
  configs: {
    a: { config: { panoId: 'a', title: 'Square', hotspots: [] }, etag: 'ea' },
    b: { config: { panoId: 'b', title: 'Church', hotspots: [] }, etag: 'eb' },
    c: { config: { panoId: 'c', title: 'Hall', hotspots: [] }, etag: 'ec' },
  },
});

function setup(
  over: Partial<MapPanelProps> = {},
  scenes = [
    { panoId: 'a', mapX: 0.2, mapY: 0.3 },
    { panoId: 'b' },
    { panoId: 'c', mapX: 0.8, mapY: 0.5 },
  ],
) {
  const props: MapPanelProps = {
    docs: fromServer(server(scenes)),
    currentId: 'a',
    plan: null,
    onPlace: vi.fn(),
    onRemove: vi.fn(),
    onSelect: vi.fn(),
    onPlanFile: vi.fn(),
    onRemovePlan: vi.fn(),
    ...over,
  };
  const r = render(<MapPanel {...props} />);
  return { ...props, ...r };
}

const open = () => fireEvent.click(screen.getByRole('button', { name: /^Map/ }));
const plan = () => within(screen.getByRole('group', { name: 'Floor plan' }));
const dot = (name: string) => plan().getByRole('button', { name: new RegExp(`^${name},`) });

/** jsdom has no layout: give the plan a 200×100 box at (10, 20). */
const layout = () =>
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 20,
    width: 200,
    height: 100,
    right: 210,
    bottom: 120,
    x: 10,
    y: 20,
    toJSON: () => ({}),
  });

describe('MapPanel', () => {
  it('is collapsed until opened, and counts the placed panos', () => {
    setup();
    const toggle = screen.getByRole('button', { name: /^Map/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('2 of 3 placed');
    expect(screen.queryByRole('group', { name: 'Floor plan' })).toBeNull();
    open();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('draws a dot per placed pano, at its 0..1 position, the open one marked', () => {
    setup();
    open();
    const square = dot('Square');
    expect(square.getAttribute('aria-label')).toBe('Square, 20% across, 30% down');
    expect(square.style.left).toBe('20%');
    expect(square.style.top).toBe('30%');
    expect(square.getAttribute('aria-current')).toBe('true');
    expect(dot('Hall').getAttribute('aria-current')).toBeNull();
    expect(plan().queryByRole('button', { name: /^Church/ })).toBeNull();
  });

  it('moves a dot with the arrow keys, Shift for bigger steps, and Delete takes it off', () => {
    const { onPlace, onRemove } = setup();
    open();
    fireEvent.keyDown(dot('Hall'), { key: 'ArrowRight' });
    expect(onPlace).toHaveBeenLastCalledWith('c', 0.81, 0.5);
    fireEvent.keyDown(dot('Hall'), { key: 'ArrowUp', shiftKey: true });
    expect(onPlace).toHaveBeenLastCalledWith('c', 0.8, 0.45);
    fireEvent.keyDown(dot('Hall'), { key: 'Delete' });
    expect(onRemove).toHaveBeenCalledWith('c');
  });

  it('keeps a keyboard move on the plan', () => {
    const { onPlace } = setup({}, [{ panoId: 'a', mapX: 1, mapY: 0 }]);
    open();
    fireEvent.keyDown(dot('Square'), { key: 'ArrowRight', shiftKey: true });
    expect(onPlace).toHaveBeenLastCalledWith('a', 1, 0);
  });

  it('drags a dot to a new spot, with the pointer or a finger', () => {
    layout();
    const { onPlace, onSelect } = setup();
    open();
    const hall = dot('Hall');
    fireEvent.pointerDown(hall, { pointerId: 1, button: 0, clientX: 170, clientY: 70 });
    fireEvent.pointerMove(hall, { pointerId: 1, clientX: 60, clientY: 45 });
    // Follows the pointer before it lets go.
    expect(hall.style.left).toBe('25%');
    expect(hall.style.top).toBe('25%');
    fireEvent.pointerUp(hall, { pointerId: 1, clientX: 110, clientY: 70 });
    expect(onPlace).toHaveBeenCalledWith('c', 0.5, 0.5);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a press without a drag opens that pano; so does Enter', () => {
    layout();
    const { onPlace, onSelect } = setup();
    open();
    const hall = dot('Hall');
    fireEvent.pointerDown(hall, { pointerId: 2, button: 0, clientX: 170, clientY: 70 });
    fireEvent.pointerUp(hall, { pointerId: 2, clientX: 171, clientY: 71 });
    fireEvent.click(hall, { detail: 1 });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('c');
    // The keyboard's click has no press before it (detail 0).
    fireEvent.click(hall, { detail: 0 });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('a drag the browser cancels puts the dot back', () => {
    layout();
    const { onPlace } = setup();
    open();
    const hall = dot('Hall');
    fireEvent.pointerDown(hall, { pointerId: 3, button: 0, clientX: 170, clientY: 70 });
    fireEvent.pointerMove(hall, { pointerId: 3, clientX: 60, clientY: 45 });
    fireEvent.pointerCancel(hall, { pointerId: 3 });
    expect(hall.style.left).toBe('80%');
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('a click on the plan puts the open pano there', () => {
    layout();
    const { onPlace } = setup({ currentId: 'b' });
    open();
    fireEvent.click(screen.getByRole('group', { name: 'Floor plan' }), {
      clientX: 160,
      clientY: 95,
    });
    expect(onPlace).toHaveBeenCalledWith('b', 0.75, 0.75);
  });

  it('places the open pano from a button, focusing its new dot, and removes it again', () => {
    const onPlace = vi.fn();
    const { rerender, docs, ...rest } = setup({ currentId: 'b', onPlace });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Place on map' }));
    expect(onPlace).toHaveBeenCalledWith('b', 0.5, 0.5);
    // The parent applies it; the new dot takes focus for the arrow keys.
    const placed = fromServer(
      server([
        { panoId: 'a', mapX: 0.2, mapY: 0.3 },
        { panoId: 'b', mapX: 0.5, mapY: 0.5 },
        { panoId: 'c', mapX: 0.8, mapY: 0.5 },
      ]),
    );
    rerender(<MapPanel {...rest} docs={placed} currentId="b" onPlace={onPlace} plan={null} />);
    expect(document.activeElement).toBe(dot('Church'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from map' }));
    expect(rest.onRemove).toHaveBeenCalledWith('b');
    expect(docs.tour.current.scenes).toHaveLength(3);
  });

  it('puts a new dot clear of one already in the middle', () => {
    const onPlace = vi.fn<MapPanelProps['onPlace']>();
    setup({ currentId: 'b', onPlace }, [{ panoId: 'a', mapX: 0.5, mapY: 0.5 }, { panoId: 'b' }]);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Place on map' }));
    const [, x, y] = onPlace.mock.calls[0]!;
    expect(Math.hypot(x - 0.5, y - 0.5)).toBeGreaterThan(0.04);
  });

  it('draws the plan image in its own shape, and adds, replaces and removes it', () => {
    const { onPlanFile, onRemovePlan, container, rerender, ...rest } = setup();
    open();
    expect(screen.getByRole('button', { name: 'Add image' })).toBeTruthy();
    const input = screen.getByTestId('plan-input') as HTMLInputElement;
    const file = new File(['x'], 'plan.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onPlanFile).toHaveBeenCalledWith(file);

    const image = { url: 'https://cdn.test/pub/plans/t1/p.webp', width: 400, height: 300 };
    rerender(
      <MapPanel {...rest} onPlanFile={onPlanFile} onRemovePlan={onRemovePlan} plan={image} />,
    );
    const box = screen.getByRole('group', { name: 'Floor plan' });
    expect(box.style.getPropertyValue('--ed-map-ratio')).toBe(String(400 / 300));
    expect(container.querySelector('.ed-map__img')?.getAttribute('src')).toBe(image.url);
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemovePlan).toHaveBeenCalled();

    rerender(
      <MapPanel
        {...rest}
        onPlanFile={onPlanFile}
        onRemovePlan={onRemovePlan}
        plan={image}
        uploading
        planError="Use a JPG, PNG or WebP image."
      />,
    );
    expect(screen.getByRole('button', { name: 'Adding…' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert').textContent).toBe('Use a JPG, PNG or WebP image.');
  });

  it('shows where older, unit-free positions were drawn', () => {
    setup({}, [
      { panoId: 'a', mapX: 10, mapY: 0 },
      { panoId: 'c', mapX: 30, mapY: 20 },
    ]);
    open();
    expect(dot('Square').style.left).toBe('8%');
    expect(parseFloat(dot('Hall').style.left)).toBeCloseTo(92);
  });
});
