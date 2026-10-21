import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PointerLayer } from './PointerLayer.js';

afterEach(cleanup);

function setup() {
  const props = { onPick: vi.fn(), onDrag: vi.fn(), onDragEnd: vi.fn(), onCancel: vi.fn() };
  const { container } = render(<PointerLayer className="layer" hint="Hint" {...props} />);
  const el = container.querySelector('.layer')!;
  const ev = (pointerId: number, clientX: number, clientY = 0) => ({
    pointerId,
    button: 0,
    clientX,
    clientY,
  });
  return { ...props, el, ev };
}

const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

describe('PointerLayer', () => {
  it('sends drag moves at most once a frame, the latest one winning', async () => {
    const { el, ev, onDrag, onDragEnd, onPick } = setup();
    fireEvent.pointerDown(el, ev(1, 0));
    fireEvent.pointerMove(el, ev(1, 10));
    fireEvent.pointerMove(el, ev(1, 20));
    fireEvent.pointerMove(el, ev(1, 30));
    expect(onDrag).not.toHaveBeenCalled();
    await nextFrame();
    expect(onDrag.mock.calls).toEqual([
      [
        { x: 30, y: 0 },
        { x: 0, y: 0 },
      ],
    ]);
    // A move still waiting for its frame is dropped: the release carries the final spot.
    fireEvent.pointerMove(el, ev(1, 40));
    fireEvent.pointerUp(el, ev(1, 50));
    fireEvent.click(el, { clientX: 50, clientY: 0 });
    await nextFrame();
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onDragEnd.mock.calls).toEqual([
      [
        { x: 50, y: 0 },
        { x: 0, y: 0 },
      ],
    ]);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('cancels a drag the browser cancels, never committing it', async () => {
    const { el, ev, onDrag, onDragEnd, onCancel, onPick } = setup();
    fireEvent.pointerDown(el, ev(1, 0));
    fireEvent.pointerMove(el, ev(1, 30));
    fireEvent.pointerCancel(el, ev(1, 30));
    fireEvent.click(el, { clientX: 30, clientY: 0 });
    await nextFrame();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(onDrag).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    // A cancelled press that never became a drag has nothing to undo.
    fireEvent.pointerDown(el, ev(2, 0));
    fireEvent.pointerCancel(el, ev(2, 0));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('ignores a second pointer while one is pressed', async () => {
    const { el, ev, onDrag, onDragEnd, onPick } = setup();
    fireEvent.pointerDown(el, ev(1, 0));
    fireEvent.pointerDown(el, ev(2, 100));
    fireEvent.pointerMove(el, ev(2, 200));
    fireEvent.pointerUp(el, ev(2, 200));
    fireEvent.click(el, { clientX: 200, clientY: 0 });
    await nextFrame();
    expect(onDrag).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    // The first finger's drag carries on from its own start.
    fireEvent.pointerMove(el, ev(1, 30));
    fireEvent.pointerUp(el, ev(1, 30));
    expect(onDragEnd.mock.calls).toEqual([
      [
        { x: 30, y: 0 },
        { x: 0, y: 0 },
      ],
    ]);
  });

  it('treats a press that stays under the threshold as a click', () => {
    const { el, ev, onDrag, onDragEnd, onPick } = setup();
    fireEvent.pointerDown(el, ev(1, 0));
    fireEvent.pointerMove(el, ev(1, 2));
    fireEvent.pointerUp(el, ev(1, 2));
    fireEvent.click(el, { clientX: 2, clientY: 0 });
    expect(onDrag).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(onPick.mock.calls).toEqual([[{ x: 2, y: 0 }]]);
  });
});
