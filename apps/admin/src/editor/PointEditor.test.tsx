import type { Hotspot } from '@internal/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HotspotPatch } from './model.js';
import { PointEditor } from './PointEditor.js';

const noop = () => {};

function renderWith(icon?: string) {
  const point: Hotspot = { id: 'p1', type: 'info', yaw: 0, pitch: 0, title: 'Point', icon };
  render(
    <PointEditor
      point={point}
      cdnBase="https://cdn.example"
      onChange={noop}
      onFace={noop}
      onMove={noop}
      moving={false}
      onDuplicate={noop}
      onDelete={noop}
      onDone={noop}
    />,
  );
}

const checked = () =>
  within(screen.getByRole('radiogroup', { name: 'Point icon' }))
    .getAllByRole('radio')
    .filter((r) => r.getAttribute('aria-checked') === 'true')
    .map((r) => r.getAttribute('aria-label'));

afterEach(cleanup);

describe('PointEditor icon picker', () => {
  it('selects the stored icon, or info when none is set, with no note', () => {
    renderWith('bed');
    expect(checked()).toEqual(['bed']);
    expect(screen.queryByText(/isn’t available/)).toBeNull();
    cleanup();
    renderWith(undefined);
    expect(checked()).toEqual(['info']);
  });

  it('shows an off-list stored icon as circle-info and says it is not available', () => {
    renderWith('anchor');
    expect(checked()).toEqual(['circle-info']);
    expect(screen.getByText(/The stored icon “anchor” isn’t available/)).toBeTruthy();
  });
});

/** A PointEditor over a point it keeps, so body edits show up like they do in the editor. */
function Stateful({ body, onChange }: { body?: string; onChange?: (p: HotspotPatch) => void }) {
  const [point, setPoint] = useState<Hotspot>({
    id: 'p1',
    type: 'info',
    yaw: 0,
    pitch: 0,
    title: 'Point',
    ...(body !== undefined && { body }),
  });
  return (
    <PointEditor
      point={point}
      cdnBase="https://cdn.example"
      onChange={(patch) => {
        onChange?.(patch);
        setPoint((p) => {
          const next = { ...p } as Record<string, unknown>;
          for (const [k, v] of Object.entries(patch)) {
            if (v === null) delete next[k];
            else next[k] = v;
          }
          return next as unknown as Hotspot;
        });
      }}
      onFace={noop}
      onMove={noop}
      moving={false}
      onDuplicate={noop}
      onDelete={noop}
      onDone={noop}
    />
  );
}

const body = () => screen.getByLabelText(/Text/) as HTMLTextAreaElement;
const select = (start: number, end: number) => body().setSelectionRange(start, end);
const selected = () => body().value.slice(body().selectionStart, body().selectionEnd);
const toolbar = () => within(screen.getByRole('group', { name: 'Formatting' }));

describe('PointEditor markdown toolbar', () => {
  it('formats the selection from the toolbar and keeps the result selected', () => {
    render(<Stateful body="a big cat" />);
    select(2, 5);
    fireEvent.click(toolbar().getByRole('button', { name: 'Bold' }));
    expect(body().value).toBe('a **big** cat');
    expect(selected()).toBe('big');
    fireEvent.click(toolbar().getByRole('button', { name: 'Italic' }));
    expect(body().value).toBe('a ***big*** cat');
    fireEvent.click(toolbar().getByRole('button', { name: 'Bold' }));
    expect(body().value).toBe('a *big* cat');
    fireEvent.click(toolbar().getByRole('button', { name: 'Heading' }));
    expect(body().value).toBe('## a *big* cat');
    select(3, 4);
    fireEvent.click(toolbar().getByRole('button', { name: 'Link' }));
    expect(body().value).toBe('## [a](https://) *big* cat');
    expect(selected()).toBe('https://');
  });

  // jsdom isn't a Mac, so Ctrl is the modifier (formatForKey's tests cover Cmd).
  it('formats from the keyboard: Ctrl+B, I, K and Ctrl+Alt+2', () => {
    const onChange = vi.fn();
    render(<Stateful body="word" onChange={onChange} />);
    select(0, 4);
    const bold = fireEvent.keyDown(body(), { key: 'b', ctrlKey: true });
    // Handled, so the browser doesn't also act on it.
    expect(bold).toBe(false);
    expect(body().value).toBe('**word**');
    fireEvent.keyDown(body(), { key: 'i', ctrlKey: true });
    expect(body().value).toBe('***word***');
    fireEvent.keyDown(body(), { key: 'k', ctrlKey: true });
    expect(body().value).toBe('***[word](https://)***');
    fireEvent.keyDown(body(), { key: '2', code: 'Digit2', ctrlKey: true, altKey: true });
    expect(body().value).toBe('## ***[word](https://)***');
    // Other keys are left alone.
    onChange.mockClear();
    expect(fireEvent.keyDown(body(), { key: 's', ctrlKey: true })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('starts an empty body with a selected placeholder', () => {
    const onChange = vi.fn();
    render(<Stateful onChange={onChange} />);
    fireEvent.click(toolbar().getByRole('button', { name: 'Bold' }));
    expect(onChange).toHaveBeenCalledWith({ body: '**bold text**' });
    expect(selected()).toBe('bold text');
  });
});

describe('PointEditor move and duplicate', () => {
  it('offers Move (Cancel move while moving) and Duplicate', () => {
    const onMove = vi.fn();
    const onDuplicate = vi.fn();
    const point: Hotspot = { id: 'p1', type: 'info', yaw: 0, pitch: 0, title: 'Point' };
    const props = {
      point,
      cdnBase: 'https://cdn.example',
      onChange: noop,
      onFace: noop,
      onMove,
      onDuplicate,
      onDelete: noop,
      onDone: noop,
    };
    const { rerender } = render(<PointEditor {...props} moving={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(onMove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    rerender(<PointEditor {...props} moving />);
    const cancel = screen.getByRole('button', { name: 'Cancel move' });
    expect(cancel.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(cancel);
    expect(onMove).toHaveBeenCalledTimes(2);
  });
});
