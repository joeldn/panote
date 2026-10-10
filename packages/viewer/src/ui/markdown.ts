// A tiny, dependency-free Markdown subset renderer for hotspot descriptions.
// It escapes all HTML first, then layers a small, safe set of inline and block
// rules on top — enough for titles, prose, emphasis, links, and lists without
// pulling in (or auditing) a full Markdown engine.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Only allow protocols that can't execute script. Anything else (javascript:,
// data:, vbscript:) renders as plain text so a description can't smuggle code.
function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) {
    return u;
  }
  // Same-origin relative only. `/^\/(?![/\\])/` admits `/foo` but rejects
  // both `//evil.com` (protocol-relative) and `/\evil.com` — browsers
  // resolve a leading backslash the same as a leading slash per the WHATWG
  // URL spec, so `/\host` is an equivalent bypass of a `//`-only check.
  if (/^\/(?![/\\])/.test(u)) {
    return u;
  }
  return null;
}

function emphasis(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

// A private-use character marks where a finished link goes back in, so the
// emphasis and code passes never see (and mangle) an href. It is stripped
// from the input first, so the text itself can't fake a placeholder.
const MARK = '';
const MARKS = new RegExp(MARK, 'g');
const PLACEHOLDER = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');
// [label](url), where the url may hold one level of balanced parentheses.
const LINK = /\[([^\]]+)\]\(((?:[^()]|\([^()]*\))+)\)/g;

function inline(text: string): string {
  const links: string[] = [];
  let out = escapeHtml(text.replace(MARKS, ''));
  out = out.replace(LINK, (_m, label: string, rawUrl: string) => {
    const url = safeUrl(rawUrl);
    // Not escapeHtml(url) here: `text` was already escaped as a whole above,
    // so `url` (sliced out of that escaped text) is already HTML-safe.
    // Escaping it again double-encodes entities already produced by that
    // pass — e.g. `&` in a query string becomes `&amp;amp;` — corrupting
    // any link whose URL contains `&`, `<`, `>`, or `"`.
    links.push(
      url
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${emphasis(label)}</a>`
        : emphasis(label),
    );
    return `${MARK}${links.length - 1}${MARK}`;
  });
  return emphasis(out).replace(PLACEHOLDER, (_m, i: string) => links[Number(i)]!);
}

export function renderMarkdown(src: string): string {
  if (!src.trim()) return '';
  // Split into blocks on blank lines.
  const blocks = src
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/);
  const html: string[] = [];

  const ulItem = /^[-*]\s+/;
  const olItem = /^\d+\.\s+/;

  for (const block of blocks) {
    const lines = block.split('\n');

    // Heading: a single line starting with 1–6 '#'.
    const heading = lines.length === 1 && /^(#{1,6})\s+(.*)$/.exec(lines[0]!);
    if (heading) {
      const level = heading[1]!.length;
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }

    // Walk the block line by line, grouping consecutive list items (of the
    // same kind) and flushing runs of prose as paragraphs. This lets a list
    // start or end mid-block without a surrounding blank line.
    let para: string[] = [];
    const flushPara = () => {
      if (para.length) {
        html.push(`<p>${para.map(inline).join('<br>')}</p>`);
        para = [];
      }
    };

    for (let i = 0; i < lines.length;) {
      const line = lines[i]!;
      const kind = ulItem.test(line) ? 'ul' : olItem.test(line) ? 'ol' : null;
      if (!kind) {
        para.push(line);
        i++;
        continue;
      }
      flushPara();
      const strip = kind === 'ul' ? ulItem : olItem;
      const items: string[] = [];
      while (i < lines.length && strip.test(lines[i]!)) {
        items.push(`<li>${inline(lines[i]!.replace(strip, ''))}</li>`);
        i++;
      }
      html.push(`<${kind}>${items.join('')}</${kind}>`);
    }
    flushPara();
  }

  return html.join('');
}
