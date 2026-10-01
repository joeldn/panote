import { describe, expect, it } from 'vitest';

import { isIndexable, NOINDEX, robotsTxt } from './robots.js';

describe('isIndexable', () => {
  it.each([
    ['production', true],
    ['dev', false],
    ['', false],
    [undefined, false],
    ['prod', false],
  ])('%s -> %s', (mode, expected) => {
    expect(isIndexable(mode)).toBe(expected);
  });
});

describe('robotsTxt', () => {
  it('disallows everything when not indexable', () => {
    expect(robotsTxt(false)).toBe('User-agent: *\nDisallow: /\n');
  });

  it('allows everything when indexable', () => {
    expect(robotsTxt(true)).toBe('User-agent: *\nAllow: /\n');
  });

  it('pins the header value', () => {
    expect(NOINDEX).toBe('noindex, nofollow');
  });
});
