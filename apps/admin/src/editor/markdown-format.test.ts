import { describe, expect, it } from 'vitest';

import {
  applyFormat,
  formatForKey,
  type FormatKey,
  type MarkdownFormat,
  type TextEdit,
} from './markdown-format.js';

/** `[` and `]` in the input mark the selection; the result is written back the same way. */
function fmt(marked: string, format: MarkdownFormat): string {
  const start = marked.indexOf('[');
  const end = marked.indexOf(']') - 1;
  const value = marked.replace('[', '').replace(']', '');
  const out: TextEdit = applyFormat({ value, start, end }, format);
  return `${out.value.slice(0, out.start)}[${out.value.slice(out.start, out.end)}]${out.value.slice(out.end)}`;
}

describe('applyFormat', () => {
  it('wraps the selection in bold or italic, keeping it selected', () => {
    expect(fmt('a [big] cat', 'bold')).toBe('a **[big]** cat');
    expect(fmt('a [big] cat', 'italic')).toBe('a *[big]* cat');
  });

  it('inserts a selected placeholder when nothing is selected', () => {
    expect(fmt('a []', 'bold')).toBe('a **[bold text]**');
    expect(fmt('[]', 'italic')).toBe('*[italic text]*');
  });

  it('unwraps on a second press, telling bold and italic apart', () => {
    expect(fmt('a **[big]** cat', 'bold')).toBe('a [big] cat');
    expect(fmt('a *[big]* cat', 'italic')).toBe('a [big] cat');
    // Italic over bold adds to it, and bold over italic too: neither eats the other.
    expect(fmt('a **[big]** cat', 'italic')).toBe('a ***[big]*** cat');
    expect(fmt('a *[big]* cat', 'bold')).toBe('a ***[big]*** cat');
    expect(fmt('a ***[big]*** cat', 'italic')).toBe('a **[big]** cat');
    expect(fmt('a ***[big]*** cat', 'bold')).toBe('a *[big]* cat');
  });

  it('makes the line a heading block the viewer renders, and back again', () => {
    expect(fmt('Gal[le]ry', 'heading')).toBe('## Gal[le]ry');
    expect(fmt('## Gal[le]ry', 'heading')).toBe('Gal[le]ry');
    // The viewer only renders a one-line block as a heading: blank lines go around it.
    expect(fmt('Intro\nGal[]lery\nMore', 'heading')).toBe('Intro\n\n## Gal[]lery\n\nMore');
    expect(fmt('Intro\n[Gallery]', 'heading')).toBe('Intro\n\n## [Gallery]');
    expect(fmt('Intro\n\n[Gallery]\n\nMore', 'heading')).toBe('Intro\n\n## [Gallery]\n\nMore');
  });

  // Links use brackets themselves, so these spell the selection out.
  it('turns the selection into a link with the URL selected to type over', () => {
    const value = 'see the map here';
    const out = applyFormat({ value, start: 4, end: 11 }, 'link');
    expect(out.value).toBe('see [the map](https://) here');
    expect(out.value.slice(out.start, out.end)).toBe('https://');
  });

  it('inserts a link with its label selected when nothing is selected', () => {
    const out = applyFormat({ value: 'see ', start: 4, end: 4 }, 'link');
    expect(out.value).toBe('see [link text](https://)');
    expect(out.value.slice(out.start, out.end)).toBe('link text');
  });
});

describe('formatForKey', () => {
  const key = (k: string, mods: Partial<FormatKey> = {}, mac = false) =>
    formatForKey(
      { key: k, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods },
      mac,
    );

  it('maps Ctrl with B, I, K and Ctrl+Alt+2 off a Mac', () => {
    expect(key('b', { ctrlKey: true })).toBe('bold');
    expect(key('B', { ctrlKey: true })).toBe('bold');
    expect(key('i', { ctrlKey: true })).toBe('italic');
    expect(key('k', { ctrlKey: true })).toBe('link');
    expect(key('2', { ctrlKey: true, altKey: true, code: 'Digit2' })).toBe('heading');
    // Cmd isn't the modifier here.
    expect(key('b', { metaKey: true })).toBeNull();
  });

  it('leaves AltGr alone: Windows reports it as Ctrl+Alt', () => {
    // Spanish/Swiss AltGr+2 types @, French ~, German ².
    expect(key('@', { ctrlKey: true, altKey: true, code: 'Digit2' })).toBeNull();
    expect(key('~', { ctrlKey: true, altKey: true, code: 'Digit2' })).toBeNull();
    expect(
      key('2', {
        ctrlKey: true,
        altKey: true,
        code: 'Digit2',
        getModifierState: (m) => m === 'AltGraph',
      }),
    ).toBeNull();
  });

  it('uses only Cmd on a Mac, so Ctrl+B and Ctrl+K keep their text-field meanings', () => {
    expect(key('b', { metaKey: true }, true)).toBe('bold');
    expect(key('i', { metaKey: true }, true)).toBe('italic');
    expect(key('k', { metaKey: true }, true)).toBe('link');
    expect(key('™', { metaKey: true, altKey: true, code: 'Digit2' }, true)).toBe('heading');
    expect(key('b', { ctrlKey: true }, true)).toBeNull();
    expect(key('k', { ctrlKey: true }, true)).toBeNull();
  });

  it('ignores plain keys and other shortcuts', () => {
    expect(key('b')).toBeNull();
    expect(key('s', { ctrlKey: true })).toBeNull();
    expect(key('b', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key('b', { ctrlKey: true, altKey: true, code: 'KeyB' })).toBeNull();
  });
});
