import { POINT_ICONS } from '@internal/ui';
import { describe, expect, it } from 'vitest';

import { searchIcons } from './icons.js';

describe('searchIcons', () => {
  it('offers every point icon for an empty query and filters by substring', () => {
    expect(searchIcons('  ')).toEqual([...POINT_ICONS]);
    expect(searchIcons('Book')).toEqual(['book', 'book-open']);
  });

  it('does not offer a typed-in name outside the subset', () => {
    expect(searchIcons('anchor')).toEqual([]);
  });
});
