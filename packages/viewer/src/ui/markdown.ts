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
  if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u) || u.startsWith('/')) {
    return u;
  }
  return null;
}

function inline(text: string): string {
  let out = escapeHtml(text);
  // Links: [label](url) — resolved before emphasis so labels can be styled.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, rawUrl: string) => {
    const url = safeUrl(rawUrl);
    if (!url) return label;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return out;
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
