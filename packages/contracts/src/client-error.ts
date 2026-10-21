import { z } from 'zod';

// Frontend error reports (POST /api/errors on public-api). Privacy first: no
// user, client id, query string, fragment or full URL, only what helps find
// the bug. The reporter scrubs and caps before sending; public-api checks the
// shape and scrubs again, so a hand-made report gets the same treatment.

export const CLIENT_ERROR_APPS = ['website', 'admin'] as const;
export type ClientErrorApp = (typeof CLIENT_ERROR_APPS)[number];

export const CLIENT_ERROR_KINDS = ['error', 'unhandledrejection'] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

export const MAX_ERROR_MESSAGE_LENGTH = 300;
export const MAX_ERROR_FRAMES = 5;
export const MAX_ERROR_FRAME_LENGTH = 200;
export const MAX_ERROR_PATH_LENGTH = 120;
// The build's entry chunk hash (e.g. `BxR2v9Qe`), or `local` for a dev server.
export const ERROR_RELEASE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// Everything here is linear in the text: one pass over its tokens, then plain
// scans inside each. (A backtracking regex over a long word took seconds.)

// A run of text with no whitespace, quote, paren or angle bracket: the most a
// URL can be inside a message or a stack frame.
const TOKEN = /[^\s()'"<>`]+/g;
// Where a URL can start inside a token, glued to whatever precedes it
// (`url=https://...`, `[https://...]`, `src=/api/x?...`). Each pattern does
// constant work per position, so the search stays linear.
// A data: or blob: URL, not the end of a word like `metadata:`.
const DATA_URL = /(?:^|[^a-z0-9])(?:data|blob):/i;
// A path: `/` at the token start or right after `=`, `:`, `,` or `[`.
const PATH_START = /(?:^|[=:,[])\//;
const IP_OR_LOCALHOST = /(?:\b\d{1,3}(?:\.\d{1,3}){3}|\blocalhost)(?::\d+)?\//i;
// A host.tld (optional port), followed by a path, query, fragment or the end.
// Sticky: only tried at the token start and right after `=` `:` `,` `[` `@`.
const HOST = /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?=[/?#]|$)/iy;
const HOST_AFTER = new Set(['=', ':', ',', '[', '@']);
const SCHEME_CHAR = /[a-z0-9+.-]/i;
// The `:line:col` a stack frame puts after a URL, which is kept.
const LINE_COL = /:\d+:\d+$/;
// Sticky, so it only runs from the character after an `@`.
const EMAIL_DOMAIN = /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/iy;
const NOT_LOCAL_PART = new Set(['/', ':', '@', ',', ';', '=']);
// A tour's slug can be its only secret (an unlisted tour), and its id points at
// one owner's content, wherever they show up: page paths, API paths, R2 keys.
const ID_SEGMENT = /\/(s|slugs|pub\/tours|api\/tours|api\/admin\/tours|app\/t)\/[^/\s?#()'"<>`]+/gi;

// Index of the first place a URL starts in the token, or -1.
const urlStart = (token: string): number => {
  const starts: number[] = [];
  const scheme = token.indexOf('://');
  if (scheme !== -1) {
    let at = scheme;
    while (at > 0 && SCHEME_CHAR.test(token[at - 1]!)) at--;
    starts.push(at);
  }
  for (const re of [DATA_URL, PATH_START, IP_OR_LOCALHOST]) {
    const m = re.exec(token);
    if (m) starts.push(m.index);
  }
  const before = starts.length ? Math.min(...starts) : token.length;
  for (let at = 0; at < before; at++) {
    if (at > 0 && !HOST_AFTER.has(token[at - 1]!)) continue;
    HOST.lastIndex = at;
    if (HOST.test(token)) {
      starts.push(at);
      break;
    }
  }
  return starts.length ? Math.min(...starts) : -1;
};

// Drops everything from the first `?` or `#` after a URL starts in the token,
// keeping a frame's trailing `:line:col`. The token is never split at `=` or `,`:
// that would cut a query into pieces and keep the later ones.
const stripQuery = (token: string): string => {
  const start = urlStart(token);
  if (start === -1) return token;
  const rest = token.slice(start).search(/[?#]/);
  if (rest === -1) return token;
  const q = start + rest;
  return token.slice(0, q) + (LINE_COL.exec(token.slice(q))?.[0] ?? '');
};

// `local@host.tld` becomes `<email>`. A Firefox frame (`fn@https://...`) has an
// `@` too, but no dotted host right after it.
const maskEmails = (token: string): string => {
  let out = '';
  let last = 0;
  for (let at = token.indexOf('@'); at !== -1; at = token.indexOf('@', at + 1)) {
    let start = at;
    while (start > last && !NOT_LOCAL_PART.has(token[start - 1]!)) start--;
    if (start === at) continue;
    EMAIL_DOMAIN.lastIndex = at + 1;
    const domain = EMAIL_DOMAIN.exec(token);
    if (!domain) continue;
    out += `${token.slice(last, start)}<email>`;
    last = at + 1 + domain[0].length;
    at = last - 1;
  }
  return out + token.slice(last);
};

/**
 * Drops query strings and fragments from URLs wherever they start in a token
 * (absolute, data: and blob: URLs, paths, IPv4/localhost and host.tld hosts),
 * and masks emails, tour slugs and tour ids.
 */
export const scrubErrorText = (text: string): string =>
  text
    .replace(TOKEN, (token) => maskEmails(stripQuery(token)))
    .replace(ID_SEGMENT, (_m, prefix: string) =>
      /^s(lugs)?$/i.test(prefix) ? `/${prefix}/:slug` : `/${prefix}/:tourId`,
    );

export const ClientErrorReportSchema = z.object({
  app: z.enum(CLIENT_ERROR_APPS),
  release: z.string().regex(ERROR_RELEASE_PATTERN),
  kind: z.enum(CLIENT_ERROR_KINDS),
  message: z.string().max(MAX_ERROR_MESSAGE_LENGTH),
  // Top frames only, as the browser formats them.
  stack: z.array(z.string().max(MAX_ERROR_FRAME_LENGTH)).max(MAX_ERROR_FRAMES),
  // A pathname, never a query string or fragment.
  path: z
    .string()
    .max(MAX_ERROR_PATH_LENGTH)
    .regex(/^\/[^?#\s]*$/),
});
export type ClientErrorReport = z.infer<typeof ClientErrorReportSchema>;
