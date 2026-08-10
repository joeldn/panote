import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown.js';

describe('renderMarkdown', () => {
  it('escapes HTML to prevent injection', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('renders headings', () => {
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>');
    expect(renderMarkdown('### Small')).toBe('<h3>Small</h3>');
  });

  it('renders bold and italic', () => {
    expect(renderMarkdown('**bold** and *italic*')).toBe(
      '<p><strong>bold</strong> and <em>italic</em></p>',
    );
  });

  it('renders inline code', () => {
    expect(renderMarkdown('use `code` here')).toBe('<p>use <code>code</code> here</p>');
  });

  it('renders safe http links', () => {
    expect(renderMarkdown('[site](https://example.com)')).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a></p>',
    );
  });

  it('strips javascript: links, keeping the text', () => {
    expect(renderMarkdown('[x](javascript:alert)')).toBe('<p>x</p>');
  });

  it('allows mailto and relative links', () => {
    expect(renderMarkdown('[mail](mailto:a@b.com)')).toContain('href="mailto:a@b.com"');
    expect(renderMarkdown('[rel](/tour)')).toContain('href="/tour"');
  });

  it('renders unordered lists', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('renders ordered lists', () => {
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
  });

  it('renders a list that follows text in the same block', () => {
    expect(renderMarkdown('Features:\n- one\n- two')).toBe(
      '<p>Features:</p><ul><li>one</li><li>two</li></ul>',
    );
  });

  it('renders text after a list in the same block', () => {
    expect(renderMarkdown('- one\n- two\nafter')).toBe(
      '<ul><li>one</li><li>two</li></ul><p>after</p>',
    );
  });

  it('separates paragraphs on blank lines', () => {
    expect(renderMarkdown('first\n\nsecond')).toBe('<p>first</p><p>second</p>');
  });

  it('treats a single newline inside a paragraph as a line break', () => {
    expect(renderMarkdown('a\nb')).toBe('<p>a<br>b</p>');
  });

  it('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   ')).toBe('');
  });

  it('escapes html inside inline markup', () => {
    expect(renderMarkdown('**<b>**')).toBe('<p><strong>&lt;b&gt;</strong></p>');
  });
});
