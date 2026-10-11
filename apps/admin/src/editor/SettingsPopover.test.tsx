import { DEFAULT_TOUR_SETTINGS, MAX_TOUR_DESCRIPTION_LENGTH } from '@internal/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsPopover } from './SettingsPopover.js';

afterEach(cleanup);

/** Holds the description like the editor does: the stored value is the trimmed one. */
function Harness({
  initial,
  onDescription,
}: {
  initial: string;
  onDescription: (t: string) => void;
}) {
  const [stored, setStored] = useState(initial);
  return (
    <SettingsPopover
      settings={DEFAULT_TOUR_SETTINGS}
      description={stored}
      onChange={() => {}}
      onDescription={(text) => {
        onDescription(text);
        setStored(text.trim());
      }}
      onClose={() => {}}
    />
  );
}

const field = () => screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;

describe('SettingsPopover description', () => {
  it('shows the stored description in a labelled, capped textarea', () => {
    render(<Harness initial="Old town at dusk" onDescription={() => {}} />);
    expect(field().value).toBe('Old town at dusk');
    expect(field().maxLength).toBe(MAX_TOUR_DESCRIPTION_LENGTH);
  });

  it('describes the field with its hint and a live character count', () => {
    render(<Harness initial="Old town" onDescription={() => {}} />);
    const ids = field().getAttribute('aria-describedby')!.split(' ');
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toEqual([
      'Shown in link previews. The first 160 or so characters show in search results.',
      `8 / ${MAX_TOUR_DESCRIPTION_LENGTH}`,
    ]);
    // Counts what's in the field, a trailing space included.
    fireEvent.change(field(), { target: { value: 'Old town at dusk ' } });
    expect(document.getElementById(ids[1]!)?.textContent).toBe(
      `17 / ${MAX_TOUR_DESCRIPTION_LENGTH}`,
    );
  });

  it('sends every change, and keeps spaces being typed until the field loses focus', () => {
    const onDescription = vi.fn();
    render(<Harness initial="" onDescription={onDescription} />);
    fireEvent.change(field(), { target: { value: 'Old ' } });
    expect(onDescription).toHaveBeenLastCalledWith('Old ');
    expect(field().value).toBe('Old ');
    fireEvent.blur(field());
    expect(field().value).toBe('Old');
  });
});
