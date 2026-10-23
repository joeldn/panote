import type { TourWithConfigsOk } from '@internal/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapPanel, type MapPanelProps } from './MapPanel.js';
import { editorReducer, fromServer, type EditorAction, type EditorDocs } from './model.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // The card remembers whether it was open.
  localStorage.clear();
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
    shown: true,
    onShownChange: vi.fn(),
    onPlace: vi.fn(),
    onRemove: vi.fn(),
    onSuggest: vi.fn(),
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

  it('remembers whether it was open, and folds again from its head', () => {
    setup();
    open();
    cleanup();
    setup();
    const toggle = screen.getByRole('button', { name: /^Map/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('group', { name: 'Floor plan' })).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByRole('group', { name: 'Floor plan' })).toBeNull();
    expect(localStorage.getItem('panote.editor.panel.map')).toBe('closed');
  });

  it('has the switch that shows the map to visitors in its head, folded or open', () => {
    const { onShownChange, rerender, ...rest } = setup({ shown: false });
    const head = within(screen.getByRole('heading', { name: /^Map/ }).closest('header')!);
    const toggle = head.getByRole('switch', { name: 'Show the map to visitors' });
    expect(toggle).toHaveProperty('checked', false);
    // Turning it on opens the card, to put the panos on the plan.
    fireEvent.click(toggle);
    expect(onShownChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('group', { name: 'Floor plan' })).toBeTruthy();
    rerender(<MapPanel {...rest} onShownChange={onShownChange} shown />);
    fireEvent.click(screen.getByRole('switch', { name: 'Show the map to visitors' }));
    expect(onShownChange).toHaveBeenLastCalledWith(false);
    // Turning it off leaves the card as it is.
    expect(screen.getByRole('group', { name: 'Floor plan' })).toBeTruthy();
  });

  it('says how placing works only until the first pano is on the plan', () => {
    setup({}, [{ panoId: 'a' }, { panoId: 'b' }]);
    open();
    expect(screen.getByText(/Drag each pano to where it was taken/)).toBeTruthy();
    cleanup();
    setup();
    expect(screen.queryByText(/Drag each pano to where it was taken/)).toBeNull();
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

  it('offers only Add plan image until there is a plan', () => {
    setup();
    open();
    expect(screen.getByRole('button', { name: 'Add plan image' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Plan image' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('draws the plan image in its own shape, and adds, replaces and removes it', () => {
    const { onPlanFile, onRemovePlan, container, rerender, ...rest } = setup();
    open();
    const browse = vi.spyOn(HTMLInputElement.prototype, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Add plan image' }));
    const input = screen.getByTestId('plan-input') as HTMLInputElement;
    expect(browse.mock.contexts).toEqual([input]);
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
    const controls = within(screen.getByRole('group', { name: 'Plan image' }));
    expect(controls.getByRole('button', { name: 'Replace' })).toBeTruthy();
    fireEvent.click(controls.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('button', { name: 'Add plan image' })).toBeNull();
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

  describe('Suggest positions', () => {
    const linked = (): TourWithConfigsOk => {
      const res = server([{ panoId: 'a', mapX: 0.2, mapY: 0.3 }, { panoId: 'b' }, { panoId: 'c' }]);
      // The square faces north at yaw 0: the church is due east of it, the hall south.
      res.configs.a = {
        config: {
          panoId: 'a',
          title: 'Square',
          north: 0,
          hotspots: [
            {
              id: 'l1',
              type: 'link',
              yaw: Math.PI / 2,
              pitch: -0.4,
              title: 'B',
              targetPanoId: 'b',
            },
            { id: 'l2', type: 'link', yaw: Math.PI, pitch: -0.4, title: 'C', targetPanoId: 'c' },
          ],
        },
        etag: 'ea',
      };
      return res;
    };

    /** The panel over the real editor model, with an undo that steps back one edit. */
    function Harness({ initial }: { initial: EditorDocs }) {
      const [past, setPast] = useState<EditorDocs[]>([]);
      const [docs, setDocs] = useState(initial);
      const apply = (action: EditorAction) => {
        setPast((p) => [...p, docs]);
        setDocs(editorReducer(docs, action)!);
      };
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setDocs(past.at(-1) ?? docs);
              setPast((p) => p.slice(0, -1));
            }}
          >
            Undo
          </button>
          <MapPanel
            docs={docs}
            currentId={null}
            plan={null}
            shown
            onShownChange={vi.fn()}
            onPlace={(panoId, x, y) => apply({ type: 'map/place', panoId, x, y })}
            onRemove={(panoId) => apply({ type: 'map/remove', panoId })}
            onSuggest={(positions) => apply({ type: 'map/suggest', positions })}
            onSelect={vi.fn()}
            onPlanFile={vi.fn()}
            onRemovePlan={vi.fn()}
          />
        </>
      );
    }

    it('places every unplaced pano from its links in one edit that one undo takes back', () => {
      render(<Harness initial={fromServer(linked())} />);
      open();
      const status = screen.getByRole('status');
      expect(status.textContent).toBe('');
      fireEvent.click(screen.getByRole('button', { name: 'Suggest positions' }));
      expect(status.textContent).toBe('Placed 2 panos from their links. Drag any that are off.');
      expect(dot('Square').getAttribute('aria-label')).toBe('Square, 20% across, 30% down');
      const church = dot('Church');
      const hall = dot('Hall');
      expect(parseFloat(church.style.left)).toBeGreaterThan(20);
      expect(church.style.top).toBe('30%');
      expect(hall.style.left).toBe('20%');
      expect(parseFloat(hall.style.top)).toBeGreaterThan(30);
      expect(screen.getByRole('button', { name: 'Suggest positions' })).toHaveProperty(
        'disabled',
        true,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(plan().queryByRole('button', { name: /^Church,/ })).toBeNull();
      expect(plan().queryByRole('button', { name: /^Hall,/ })).toBeNull();
      expect(dot('Square').getAttribute('aria-label')).toBe('Square, 20% across, 30% down');
    });

    const suggestIn = (res: TourWithConfigsOk) => {
      render(<Harness initial={fromServer(res)} />);
      open();
      fireEvent.click(screen.getByRole('button', { name: 'Suggest positions' }));
      const text = screen.getByRole('status').textContent;
      cleanup();
      localStorage.clear();
      return text;
    };
    const withLinks = (
      res: TourWithConfigsOk,
      north: number | undefined,
      to: string[],
    ): TourWithConfigsOk => {
      res.configs.a = {
        config: {
          panoId: 'a',
          title: 'Square',
          ...(north !== undefined && { north }),
          hotspots: to.map((t, i) => ({
            id: `l${i}`,
            type: 'link' as const,
            yaw: (i * Math.PI) / 2,
            pitch: -0.4,
            title: t,
            targetPanoId: t,
          })),
        },
        etag: 'ea',
      };
      return res;
    };

    it('says how many it placed, and how many of those by their links', () => {
      const placedA = () =>
        server([{ panoId: 'a', mapX: 0.5, mapY: 0.5 }, { panoId: 'b' }, { panoId: 'c' }]);
      // Both by a link's direction.
      expect(suggestIn(withLinks(placedA(), 0, ['b', 'c']))).toBe(
        'Placed 2 panos from their links. Drag any that are off.',
      );
      // One by its link, one with no link at all.
      expect(suggestIn(withLinks(placedA(), 0, ['b']))).toBe(
        'Placed 2 panos, 1 from their links. Drag any that are off.',
      );
      // No links.
      expect(suggestIn(placedA())).toBe('Placed 2 panos. Drag any that are off.');
      // One pano.
      expect(suggestIn(server([{ panoId: 'a' }]))).toBe('Placed 1 pano. Drag it if it’s off.');
    });

    it('asks for north when a link has no direction', () => {
      expect(
        suggestIn(withLinks(server([{ panoId: 'a' }, { panoId: 'b' }]), undefined, ['b'])),
      ).toBe(
        'Placed 2 panos. Drag any that are off. Set North is here on more panos for better suggestions.',
      );
      // Partly by direction: the hint still shows for the rest.
      const res = withLinks(
        server([{ panoId: 'a', mapX: 0.5, mapY: 0.5 }, { panoId: 'b' }, { panoId: 'c' }]),
        0,
        ['b'],
      );
      res.configs.c = {
        config: {
          panoId: 'c',
          title: 'Hall',
          hotspots: [
            { id: 'l9', type: 'link', yaw: 1, pitch: -0.4, title: 'B', targetPanoId: 'b' },
          ],
        },
        etag: 'ec',
      };
      expect(suggestIn(res)).toBe(
        'Placed 2 panos, 1 from their links. Drag any that are off. Set North is here on more panos for better suggestions.',
      );
    });

    it('drops the line once the tour changes: a move, a remove, an undo or any other edit', () => {
      render(<Harness initial={fromServer(linked())} />);
      open();
      const status = screen.getByRole('status');
      const suggest = () => {
        fireEvent.click(screen.getByRole('button', { name: 'Suggest positions' }));
        expect(status.textContent).not.toBe('');
      };
      const undo = () => fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

      suggest();
      fireEvent.keyDown(dot('Church'), { key: 'ArrowRight' });
      expect(status.textContent).toBe('');
      undo();
      undo();

      suggest();
      fireEvent.keyDown(dot('Hall'), { key: 'Delete' });
      expect(status.textContent).toBe('');
      undo();
      undo();

      suggest();
      undo();
      expect(status.textContent).toBe('');
    });

    it('is off when every pano is placed', () => {
      const { onSuggest } = setup({}, [{ panoId: 'a', mapX: 0.2, mapY: 0.3 }]);
      open();
      const button = screen.getByRole('button', { name: 'Suggest positions' });
      expect(button).toHaveProperty('disabled', true);
      fireEvent.click(button);
      expect(onSuggest).not.toHaveBeenCalled();
    });
  });
});
