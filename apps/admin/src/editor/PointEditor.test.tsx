import type { Hotspot } from '@internal/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

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
