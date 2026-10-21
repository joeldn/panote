import type { JwtVerifier } from './env.js';

/**
 * Installs (or clears) the globalThis.__verifyJwt seam. The ONLY place in the
 * repo that knows that name. Test files call this from beforeAll; nothing else
 * may touch globalThis.__verifyJwt.
 */
export const setTestJwtVerifier = (verify: JwtVerifier | undefined): void => {
  globalThis.__verifyJwt = verify;
};

/**
 * Parses a wrangler.jsonc as tests read it (imported with `?raw`): `//` and
 * `/* *\/` comments and trailing commas removed, string contents left alone.
 */
export const parseJsonc = (text: string): unknown => {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      // Copy the whole string, escapes included, so "https://..." survives.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) throw new Error('unterminated comment');
      i++;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as unknown;
};
