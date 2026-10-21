import type { Hotspot } from '@internal/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PointEditor } from './PointEditor.js';

const noop = () => {};

function renderWith(icon?: string) {
  const point: Hotspot = { id: 'p1', type: 'info', yaw: 0, pitch: 0, title: 'Point', icon };
  render(<PointEditor point={point} onChange={noop} onFace={noop} onDelete={noop} onDone={noop} />);
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
    <PointEditor point={point} onChange={onChange} onFace={noop} onDelete={noop} onDone={noop} />,
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
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
