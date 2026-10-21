import { describe, expect, it } from 'vitest';

import { parseJsonc } from './testing.js';

describe('parseJsonc', () => {
  it('drops comments and trailing commas but not string contents', () => {
    const text = `{
      // a line comment
      "url": "https://panote.dev/api/*", /* a block
      comment */ "list": [1, 2,],
      "quote": "a \\"//\\" b",
    }`;
    expect(parseJsonc(text)).toEqual({
      url: 'https://panote.dev/api/*',
      list: [1, 2],
      quote: 'a "//" b',
    });
  });

  it('refuses an unterminated block comment', () => {
    expect(() => parseJsonc('{ /* x ')).toThrow(/unterminated/);
  });
});
