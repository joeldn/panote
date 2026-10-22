// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Copy rule (docs/design/NOTES.md): free, not open source; no export/download promises.
const BANNED = /open[\s-]*source|\bmit\b|github|export|download/i;
// GitHub as a sign-in provider names an account you sign in with, not where code lives, so it
// may appear only inside a list of sign-in providers: another provider before it, and another
// provider (or the email code option) after it.
const PROVIDER = '(?:Google|Apple|Microsoft|LinkedIn|Facebook)';
const SIGN_IN_PROVIDERS = new RegExp(
  `${PROVIDER},\\s+GitHub(?=(?:,|\\s+or)\\s+(?:${PROVIDER}|an email code)\\b)`,
  'g',
);
const isBanned = (text: string) => BANNED.test(text.replace(SIGN_IN_PROVIDERS, ''));
// Product limits are real (caps per scene, tour and account): say "generous", never "unlimited".
const LIMITLESS = /unlimited|no[\s-]+limits?\b|limitless|no counting/i;
const SRC = new URL('.', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__fixtures__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

/** Every piece of text a user could see: string/template literals and JSX text. */
function copyIn(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    // Module specifiers are code, not copy.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('copy rule', () => {
  const files = sourceFiles(SRC);

  it('scans the website sources', () => {
    expect(files.some((f) => f.endsWith('landing/content.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('legal/Legal.tsx'))).toBe(true);
  });

  it('flags banned words', () => {
    for (const bad of ['Open source', 'MIT licence', 'on GitHub', 'Export tours', 'download'])
      expect(isBanned(bad)).toBe(true);
    expect(isBanned('No limits, submit')).toBe(false);
    for (const bad of ['Unlimited tours', 'free with no limits', 'No-limit plan', 'no counting'])
      expect(LIMITLESS.test(bad)).toBe(true);
    for (const ok of ['Generous limits', 'Are there resolution limits?'])
      expect(LIMITLESS.test(ok)).toBe(false);
  });

  it('lets GitHub appear only inside a list of sign-in providers', () => {
    expect(isBanned('Google, Apple, Microsoft, GitHub, LinkedIn or Facebook')).toBe(false);
    expect(isBanned('Microsoft, GitHub,\n        LinkedIn')).toBe(false);
    expect(isBanned('Google, Apple, GitHub or an email code')).toBe(false);
    expect(isBanned('Apple, GitHub and our source')).toBe(true);
    expect(isBanned('Apple, GitHub, and the code')).toBe(true);
    expect(isBanned('Apple, GitHub or download')).toBe(true);
    expect(isBanned('GitHub, LinkedIn')).toBe(true);
    expect(isBanned('Microsoft, GitHub, LinkedIn. Source on GitHub')).toBe(true);
    expect(isBanned('Continue with GitHub')).toBe(true);
  });

  it.each(files.map((f) => [relative(SRC, f), f]))('%s has no banned copy', (_, file) => {
    expect(copyIn(file).filter(isBanned)).toEqual([]);
  });

  it.each(files.map((f) => [relative(SRC, f), f]))('%s promises no unlimited use', (_, file) => {
    expect(copyIn(file).filter((text) => LIMITLESS.test(text))).toEqual([]);
  });

  it('index.html promises no unlimited use', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html.match(new RegExp(LIMITLESS.source, 'gi'))).toBeNull();
  });
});
