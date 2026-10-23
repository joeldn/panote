// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// No browser lays these out in CI, so the narrow-width rules are checked as text, like
// editor/editor-layout.test.ts.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The body of the first `@media <query> {` block. */
function mediaBlock(css: string, query: string): string {
  const head = `@media ${query} {`;
  const at = css.indexOf(head);
  if (at < 0) return '';
  let depth = 0;
  for (let i = at + head.length - 1; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(at + head.length, i);
  }
  return '';
}

describe('narrow-width layout', () => {
  it('docks the upload chip above the editor’s phone sheet, not over it', () => {
    const phone = mediaBlock(read('./upload/upload.css'), '(max-width: 600px)');
    expect(phone).toMatch(
      /body:has\(\.ed-side--sheet\) \.up-chip \{\s*bottom: calc\(46% \+ 24px\);/,
    );
    // The sheet it clears: at most 46% tall, 16px off the bottom.
    const editor = mediaBlock(read('./editor/editor.css'), '(max-width: 600px)');
    expect(editor).toMatch(/\.ed-side \{[^}]*max-height: 46%;/);
  });

  it('wraps a person’s role and actions under their name', () => {
    const css = read('./people/people.css');
    expect(css).toMatch(/\n\.ppl__row \{[^}]*flex-wrap: wrap;/);
    expect(css).not.toMatch(/\n\.ppl__role \{[^}]*white-space: nowrap;/);
  });

  it('keeps the preview bar to its icons on a phone', () => {
    const phone = mediaBlock(read('./preview/preview.css'), '(max-width: 480px)');
    expect(phone).toMatch(/\.pv-badge__text,\s*\.pv-back__label \{[^}]*clip-path: inset\(50%\);/);
    expect(phone).toMatch(/\.pv-back \{[^}]*width: 40px;/);
  });
});
