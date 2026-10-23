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

function renderMedia(media?: Hotspot['media']) {
  const onChange = vi.fn();
  const point: Hotspot = { id: 'p1', type: 'info', yaw: 0, pitch: 0, title: 'Point', media };
  const view = render(
    <PointEditor
      point={point}
      onChange={onChange}
      onFace={noop}
      onMove={noop}
      moving={false}
      onDuplicate={noop}
      onDelete={noop}
      onDone={noop}
    />,
  );
  return { onChange, ...view };
}

describe('PointEditor media picker', () => {
  it('offers the design’s kinds and says media is only linked', () => {
    renderMedia();
    const kinds = within(screen.getByRole('radiogroup', { name: 'Media type' }))
      .getAllByRole('radio')
      .map((r) => r.textContent);
    expect(kinds).toEqual(['None', 'Image', 'Audio', 'Video', 'YouTube / Vimeo', 'Link']);
    expect(screen.getByText(/We only link to it — never host it\./)).toBeTruthy();
  });

  it('drops the note once there is media to preview', () => {
    renderMedia({ kind: 'audio', url: 'https://sounds.example/bell.mp3' });
    expect(screen.queryByText(/never host it/)).toBeNull();
  });

  it('stores an audio link from any https host', () => {
    const { onChange } = renderMedia();
    fireEvent.click(screen.getByRole('radio', { name: 'Audio' }));
    const input = screen.getByLabelText('Media link');
    fireEvent.change(input, { target: { value: 'https://sounds.example/bell.mp3' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith({
      media: { kind: 'audio', url: 'https://sounds.example/bell.mp3' },
    });
  });

  it('parses a Vimeo link to its id, and a YouTube page pasted as video to an embed', () => {
    const { onChange } = renderMedia();
    fireEvent.click(screen.getByRole('radio', { name: 'YouTube / Vimeo' }));
    const input = screen.getByLabelText('YouTube or Vimeo link');
    fireEvent.change(input, { target: { value: 'https://vimeo.com/76979871/8272103f6e' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith({
      media: { kind: 'vimeo', id: '76979871', hash: '8272103f6e' },
    });

    fireEvent.click(screen.getByRole('radio', { name: 'Video' }));
    // Picking a kind doesn't second-guess it; typing a link does.
    expect(onChange).toHaveBeenLastCalledWith({
      media: { kind: 'video', url: 'https://vimeo.com/76979871/8272103f6e' },
    });
    const field = screen.getByLabelText('Media link');
    fireEvent.change(field, { target: { value: 'https://youtu.be/dQw4w9WgXcQ' } });
    fireEvent.blur(field);
    expect(onChange).toHaveBeenLastCalledWith({ media: { kind: 'youtube', id: 'dQw4w9WgXcQ' } });
    expect(
      screen.getByRole('radio', { name: 'YouTube / Vimeo' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('refuses a non-https link', () => {
    const { onChange } = renderMedia();
    fireEvent.click(screen.getByRole('radio', { name: 'Link' }));
    const input = screen.getByLabelText('Link URL');
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert').textContent).toBe('Use a full https:// link.');
    expect(onChange).not.toHaveBeenCalledWith({ media: expect.anything() });
  });

  it('previews stored media inline as visitors see it', () => {
    const { container } = renderMedia({ kind: 'vimeo', id: '76979871' });
    expect(
      screen.getByRole('radio', { name: 'YouTube / Vimeo' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect((screen.getByLabelText('YouTube or Vimeo link') as HTMLInputElement).value).toBe(
      'https://vimeo.com/76979871',
    );
    expect(container.querySelector('.ed-media__preview iframe')?.getAttribute('src')).toBe(
      'https://player.vimeo.com/video/76979871?dnt=1',
    );
    cleanup();

    renderMedia({ kind: 'link', url: 'https://example.org/history' });
    const link = screen.getByRole('link', { name: 'Visit example.org ↗' });
    expect(link.getAttribute('rel')).toBe('nofollow ugc noopener noreferrer');
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

describe('PointEditor move, and the point menu', () => {
  const setup = (moving = false) => {
    const onMove = vi.fn();
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    const point: Hotspot = { id: 'p1', type: 'info', yaw: 0, pitch: 0, title: 'Point' };
    const props = {
      point,
      onChange: noop,
      onFace: noop,
      onMove,
      onDuplicate,
      onDelete,
      onDone: noop,
    };
    const view = render(<PointEditor {...props} moving={moving} />);
    return { ...props, ...view };
  };
  const more = () => screen.getByRole('button', { name: 'Point actions' });

  it('offers Move, and Cancel move while moving', () => {
    const { onMove, rerender, ...props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(onMove).toHaveBeenCalledTimes(1);
    rerender(<PointEditor {...props} onMove={onMove} moving />);
    const cancel = screen.getByRole('button', { name: 'Cancel move' });
    expect(cancel.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(cancel);
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it('keeps Duplicate and Delete behind a ⋯ menu', () => {
    const { onDuplicate, onDelete } = setup();
    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(more().getAttribute('aria-haspopup')).toBe('menu');
    expect(more().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(more());
    expect(more().getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'Point actions' });
    expect(more().getAttribute('aria-controls')).toBe(menu.id);
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['Duplicate', 'Delete point']);
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Duplicate' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(more());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete point' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    // Back on ⋯, for the confirm dialog to return to.
    expect(document.activeElement).toBe(more());
  });

  it('walks the menu with the arrow keys; Esc closes it back onto ⋯, and goes no further', () => {
    setup();
    const onDocKey = vi.fn((e: KeyboardEvent) => e.key === 'Escape');
    document.addEventListener('keydown', onDocKey);
    fireEvent.click(more());
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete point' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Duplicate' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more());
    // The editor's Esc (cancel placing or a move) doesn't also fire.
    expect(onDocKey.mock.results.some((r) => r.value === true)).toBe(false);
    document.removeEventListener('keydown', onDocKey);
  });

  it('closes on a press outside it', () => {
    setup();
    fireEvent.click(more());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
