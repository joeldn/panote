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
// Sticky, so it only runs from the character after an `@`. Labels may be
// non-ASCII (an internationalized domain); the TLD is letters or punycode.
const EMAIL_DOMAIN =
  /[\p{L}\p{N}\p{M}-]+(?:\.[\p{L}\p{N}\p{M}-]+)*\.(?:xn--[a-z0-9-]+|\p{L}[\p{L}\p{M}]+)/iuy;
const NOT_LOCAL_PART = new Set(['/', ':', '@', ',', ';', '=', '<', '>']);
// `%40` is an encoded `@`: `jane%40example.com` is still an email.
const ENCODED_AT = /%40/gi;
// `Bearer <token>`, whatever the token looks like.
const BEARER = /\bBearer\s+[^\s()'"<>`]+/gi;
// A JWT (or JWE): base64url of `{"...`, then up to four more dot-separated parts.
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,4}/g;
// A secret-bearing `key=value` outside a query string (a fragment, a form body,
// a message): OAuth's code, state and *_token, and the usual secret names. The
// value runs to the next `&`, `#`, `;` or `,`. Deliberately anywhere in the text,
// not only after `?` or `#`: an auth library's message can quote a bare
// `code=...&state=...`, so an innocent `exit code=1` is masked too, a cheap loss.
const SECRET_PAIR =
  /(?<![A-Za-z0-9_-])(code|state|nonce|password|sig|signature|x-amz-[a-z-]+|(?:[a-z0-9_]*_)?(?:token|secret))=[^&#;,]*/gi;
// The segment after an R2 key root, wherever the key shows up (an error, a CDN
// URL, a backup copy's key). The owner segment is base64url(sub), which decodes
// back to the sub; a pano id is enough to fetch an unlisted tour's images; a tour
// id or slug can be an unlisted tour's only secret. Not the same word inside a
// route (`/api/tours/`, `/app/panos/`), which ID_SEGMENT below handles.
// Deliberately broad: a root counts after any `/` or non-word character, not only
// at a key's start, because the key can be quoted inside an S3 URL
// (`.../<bucket>/panos/...`), a backup or quarantine copy (`backup/<date>/tours/...`)
// or an error string. The site has no page at `/tours/`, `/panos/` or `/tiles/`
// (its pages live under `/s/` and `/app/`), so what this over-masks is prose like
// `tiles/abc`, which costs a little debugging detail and never leaks.
const KEY_SEGMENT =
  /(?<![A-Za-z0-9_.-])(?<!(?:api|admin|app|pub|explore)\/)(panos|tours|accounts|upload-log|tiles|tile-gc|tour-owners|slugs|pub\/tours|pub\/plans|explore\/tours|explore\/hidden)\/[^/\s?#()'"<>`]+/gi;
const KEY_LABEL: Record<string, string> = {
  panos: ':owner',
  tours: ':owner',
  accounts: ':owner',
  'upload-log': ':owner',
  tiles: ':panoId',
  'tile-gc': ':panoId',
  slugs: ':slug',
};
// A tour's slug can be its only secret (an unlisted tour), and its id points at
// one owner's content, wherever they show up: page paths and API paths.
const ID_SEGMENT =
  /\/(s|slugs|pub\/tours|api\/tours|api\/admin\/tours|api\/admin\/panos|app\/t)\/[^/\s?#()'"<>`]+/gi;
// Pano and tour ids are crypto.randomUUID(), and so is a visitor's like id.
const UUID =
  /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;

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

// `scheme://user:pass@host` becomes `scheme://<userinfo>@host`. Each scan stops
// at the next `/`, which the next `://` holds, so the whole pass is linear.
const maskUserinfo = (token: string): string => {
  let out = '';
  let last = 0;
  for (let s = token.indexOf('://'); s !== -1; s = token.indexOf('://', s + 1)) {
    const host = s + 3;
    if (host < last) continue;
    let at = -1;
    let end = host;
    for (; end < token.length && !'/?#'.includes(token[end]!); end++) {
      if (token[end] === '@') at = end;
    }
    if (at > host) {
      out += `${token.slice(last, host)}<userinfo>`;
      last = at;
    }
  }
  return out + token.slice(last);
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

// Emails with `%40` decoded; the token comes back unchanged if none was found.
const maskEncodedEmails = (token: string): string => {
  const decoded = token.replace(ENCODED_AT, '@');
  const masked = maskEmails(decoded);
  return decoded === token || masked !== decoded ? masked : token;
};

const scrubToken = (token: string): string =>
  maskEncodedEmails(
    stripQuery(maskUserinfo(token))
      .replace(SECRET_PAIR, (_m, key: string) => `${key}=<redacted>`)
      .replace(JWT, '<jwt>'),
  );

/**
 * Drops query strings and fragments from URLs wherever they start in a token
 * (absolute, data: and blob: URLs, paths, IPv4/localhost and host.tld hosts),
 * and masks what could identify a person or open private content: emails
 * (`%40`-encoded and internationalized too), URL userinfo, bearer tokens, JWTs,
 * secret `key=value` pairs, the owner and id segments of R2 keys, tour slugs,
 * tour and pano ids, and UUIDs. Every step is linear in the text.
 */
export const scrubErrorText = (text: string): string =>
  text
    .replace(BEARER, 'Bearer <token>')
    .replace(TOKEN, scrubToken)
    .replace(
      KEY_SEGMENT,
      (_m, root: string) => `${root}/${KEY_LABEL[root.toLowerCase()] ?? ':tourId'}`,
    )
    .replace(ID_SEGMENT, (_m, prefix: string) =>
      /^s(lugs)?$/i.test(prefix)
        ? `/${prefix}/:slug`
        : /panos$/i.test(prefix)
          ? `/${prefix}/:panoId`
          : `/${prefix}/:tourId`,
    )
    .replace(UUID, '<id>');

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
