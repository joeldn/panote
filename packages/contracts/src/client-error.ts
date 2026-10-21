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
// What may come before a `?` or `#` for the token to count as a URL: an absolute
// URL, a data: or blob: URL, a path starting with `/`, or a host.tld (with an
// optional port and path). Anchored, after an optional `fn@` (a Firefox frame).
// "is it valid? no" has none of these, so prose keeps its question marks.
const URL_HEAD =
  /^(?:[^@]*@)?(?:[a-z][a-z0-9+.-]*:\/\/|(?:data|blob):|\/|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:\/|$))/i;
// The `:line:col` a stack frame puts after a URL, which is kept.
const LINE_COL = /:\d+:\d+$/;
// Sticky, so it only runs from the character after an `@`.
const EMAIL_DOMAIN = /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/iy;
const NOT_LOCAL_PART = new Set(['/', ':', '@', ',', ';', '=']);
// A tour's slug can be its only secret (an unlisted tour), and its id points at
// one owner's content, wherever they show up: page paths, API paths, R2 keys.
const ID_SEGMENT = /\/(s|slugs|pub\/tours|api\/tours|api\/admin\/tours|app\/t)\/[^/\s?#()'"<>`]+/g;

// Drops what follows the first `?` or `#` of a URL-like token, keeping a frame's
// trailing `:line:col`.
const stripQuery = (token: string): string => {
  const q = token.search(/[?#]/);
  if (q === -1 || !URL_HEAD.test(token.slice(0, q))) return token;
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
 * Drops query strings and fragments from URL-like tokens (absolute, data: and
 * blob: URLs, paths starting with `/`, host.tld/...), and masks emails, tour
 * slugs and tour ids.
 */
export const scrubErrorText = (text: string): string =>
  text
    .replace(TOKEN, (token) => maskEmails(stripQuery(token)))
    .replace(ID_SEGMENT, (_m, prefix: string) =>
      prefix === 's' || prefix === 'slugs' ? `/${prefix}/:slug` : `/${prefix}/:tourId`,
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
