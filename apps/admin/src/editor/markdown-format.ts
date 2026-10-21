// The point body's formatting toolbar: pure edits on (text, selection), in the markdown
// subset the viewer renders (packages/ui markdown.ts): **bold**, *italic*, a one-line
// `## heading` block, and [label](url).

export interface TextEdit {
  value: string;
  start: number;
  end: number;
}

export type MarkdownFormat = 'bold' | 'italic' | 'heading' | 'link';

const PLACEHOLDER: Record<'bold' | 'italic' | 'link', string> = {
  bold: 'bold text',
  italic: 'italic text',
  link: 'link text',
};
const URL_PLACEHOLDER = 'https://';

/** Asterisks running back from `at` (before) or forward from it (after). */
function starsAround(value: string, at: number, dir: -1 | 1): number {
  let n = 0;
  for (let i = dir < 0 ? at - 1 : at; value[i] === '*'; i += dir) n++;
  return n;
}

/**
 * Wraps the selection in `**` or `*`, or unwraps it when it already is. Asterisk runs
 * are counted so italic over `**bold**` adds a third one instead of eating the bold.
 */
function toggleEmphasis(edit: TextEdit, kind: 'bold' | 'italic'): TextEdit {
  const { value, start, end } = edit;
  const marker = kind === 'bold' ? '**' : '*';
  const around = Math.min(starsAround(value, start, -1), starsAround(value, end, 1));
  const wrapped = kind === 'bold' ? around === 2 || around === 3 : around === 1 || around === 3;
  if (wrapped && start !== end) {
    const n = marker.length;
    return {
      value: value.slice(0, start - n) + value.slice(start, end) + value.slice(end + n),
      start: start - n,
      end: end - n,
    };
  }
  const text = start === end ? PLACEHOLDER[kind] : value.slice(start, end);
  return {
    value: value.slice(0, start) + marker + text + marker + value.slice(end),
    start: start + marker.length,
    end: start + marker.length + text.length,
  };
}

/**
 * Makes the selection's first line a heading, or a plain line again. The renderer only
 * treats a block of one line as a heading, so blank lines go around it as needed.
 */
function toggleHeading({ value, start, end }: TextEdit): TextEdit {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const nl = value.indexOf('\n', lineStart);
  const lineEnd = nl === -1 ? value.length : nl;
  const line = value.slice(lineStart, lineEnd);
  const existing = /^#{1,6}\s+/.exec(line);
  if (existing) {
    const n = existing[0].length;
    const shift = (at: number) => Math.max(lineStart, at - n);
    return {
      value: value.slice(0, lineStart) + line.slice(n) + value.slice(lineEnd),
      start: shift(start),
      end: shift(Math.min(end, lineEnd)),
    };
  }
  const before = value.slice(0, lineStart);
  const after = value.slice(lineEnd);
  const lead =
    before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail =
    after === '' || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const prefix = lead + '## ';
  return {
    value: before + prefix + line + trail + after,
    start: start + prefix.length,
    end: Math.min(end, lineEnd) + prefix.length,
  };
}

/** `[selection](https://)` with the URL selected to type over; no selection selects the label. */
function insertLink({ value, start, end }: TextEdit): TextEdit {
  const label = start === end ? PLACEHOLDER.link : value.slice(start, end);
  const text = `[${label}](${URL_PLACEHOLDER})`;
  const labelStart = start + 1;
  const urlStart = labelStart + label.length + 2;
  return {
    value: value.slice(0, start) + text + value.slice(end),
    ...(start === end
      ? { start: labelStart, end: labelStart + label.length }
      : { start: urlStart, end: urlStart + URL_PLACEHOLDER.length }),
  };
}

export function applyFormat(edit: TextEdit, format: MarkdownFormat): TextEdit {
  switch (format) {
    case 'bold':
    case 'italic':
      return toggleEmphasis(edit, format);
    case 'heading':
      return toggleHeading(edit);
    case 'link':
      return insertLink(edit);
  }
}

/** True on Apple platforms, where the shortcuts use Cmd and Ctrl keeps its text-field keys. */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export interface FormatKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState?: (key: 'AltGraph') => boolean;
}

/**
 * The format a key press in the body asks for: Cmd (Mac) or Ctrl (elsewhere) with B, I
 * or K, and with Alt/Option+2 for a heading. Only the platform's own modifier counts, so
 * Ctrl+B and Ctrl+K keep their Mac text-field meanings.
 */
export function formatForKey(e: FormatKey, mac = IS_MAC): MarkdownFormat | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.shiftKey) return null;
  if (e.altKey) {
    // Option+2 types a character on a Mac, so there the heading goes by the physical key.
    if (mac) return e.code === 'Digit2' ? 'heading' : null;
    // Windows reports AltGr as Ctrl+Alt: AltGr+2 types `@`, `~` or `²` on many layouts,
    // so only a press that still reads as a plain 2 is the shortcut.
    if (e.getModifierState?.('AltGraph')) return null;
    return e.key === '2' ? 'heading' : null;
  }
  switch (e.key.toLowerCase()) {
    case 'b':
      return 'bold';
    case 'i':
      return 'italic';
    case 'k':
      return 'link';
    default:
      return null;
  }
}
