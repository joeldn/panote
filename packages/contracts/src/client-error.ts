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

// A URL's query string or fragment, up to the `:line:col` a stack frame puts
// after it (`.../index-x.js?v=1:10:5`), which is kept.
const URL_QUERY =
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#()'"<>]*)[?#][^\s()'"<>]*?(?=(?::\d+:\d+)?(?:[\s()'"<>]|$))/gi;
// A Firefox frame (`fn@https://...`) has an `@` too, but no dotted host right after it.
const EMAIL = /[^\s@'"<>()/:]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
// A tour's slug can be its only secret (an unlisted tour), wherever it shows up.
const SLUG_SEGMENT = /\/(s|slugs)\/[^/\s?#()'"<>]+/g;

/** Drops query strings and fragments from URLs, and masks emails and tour slugs. */
export const scrubErrorText = (text: string): string =>
  text
    .replace(URL_QUERY, '$1')
    .replace(EMAIL, '<email>')
    .replace(SLUG_SEGMENT, (_m, prefix: string) => `/${prefix}/:slug`);

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
