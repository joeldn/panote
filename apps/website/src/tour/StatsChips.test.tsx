import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StatsChips } from './StatsChips.js';

afterEach(cleanup);

describe('StatsChips', () => {
  it('announces the full view count as text, not as an aria-label on a span', () => {
    render(<StatsChips stats={{ views: 2400, likes: 7 }} liked={false} like={vi.fn()} />);
    const text = screen.getByText('2,400 views');
    const chip = text.closest('.tour-chip')!;
    expect(chip.hasAttribute('aria-label')).toBe(false);
    // The compact "2.4k" is for sighted users only, so it isn't read twice.
    expect(screen.getByText('2.4k').getAttribute('aria-hidden')).toBe('true');
  });

  it('says "Views" until the counts arrive', () => {
    render(<StatsChips stats={null} liked={false} like={vi.fn()} />);
    expect(screen.getByText('Views')).toBeTruthy();
  });
});
