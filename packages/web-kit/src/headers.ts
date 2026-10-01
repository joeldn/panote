import type { AppConfig } from './config.js';

export interface HeadersFileOptions {
  /** Extra `connect-src` origins, e.g. the R2 S3 endpoint presigned PUTs go to. */
  connectSrc?: readonly string[];
  /** `_headers` URL patterns any origin may frame (the website's embed route). */
  framable?: readonly string[];
  /** Extra `frame-src` sources, e.g. `'self'` for admin's embed preview. */
  frameSrc?: readonly string[];
  /** Adds `X-Robots-Tag: noindex` everywhere (dev builds). */
  noindex?: boolean;
}

const PLACEHOLDER = /YOUR_/i;

const originOf = (url: string): string => new URL(url).origin;

/**
 * The CSP both SPAs ship (docs/wave6-plan.md section 5). `frameAncestors` is
 * the only part that differs between routes.
 */
export function contentSecurityPolicy(
  config: Pick<AppConfig, 'cdnBase' | 'apiBase' | 'auth0'>,
  frameAncestors: string,
  extraConnectSrc: readonly string[] = [],
  extraFrameSrc: readonly string[] = [],
): string {
  const cdn = originOf(config.cdnBase);
  const connect = new Set(['self', cdn, ...extraConnectSrc.map(originOf)]);
  if (/^https?:\/\//.test(config.apiBase)) connect.add(originOf(config.apiBase));
  // A placeholder tenant is not a host worth allowing.
  if (!PLACEHOLDER.test(config.auth0.domain)) connect.add(`https://${config.auth0.domain}`);

  const src = (values: Iterable<string>) =>
    [...values].map((v) => (v === 'self' ? "'self'" : v)).join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' ${cdn} data: blob:`,
    // Hotspot video (HotspotMedia kind 'video'); media URLs outside the CDN stay blocked.
    `media-src 'self' ${cdn}`,
    `connect-src ${src(connect)}`,
    `frame-src ${[...extraFrameSrc, 'https://www.youtube-nocookie.com'].join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
}

/**
 * Render a Workers static-assets `_headers` file. Every path gets
 * `frame-ancestors 'none'`; `framable` paths drop that CSP and get `*`.
 */
export function buildHeadersFile(
  config: Pick<AppConfig, 'cdnBase' | 'apiBase' | 'auth0'>,
  options: HeadersFileOptions = {},
): string {
  const { connectSrc = [], framable = [], frameSrc = [], noindex = false } = options;
  const common = [
    'X-Content-Type-Options: nosniff',
    'Referrer-Policy: strict-origin-when-cross-origin',
    ...(noindex ? ['X-Robots-Tag: noindex'] : []),
  ];
  const block = (pattern: string, lines: string[]) =>
    [pattern, ...lines.map((l) => `  ${l}`)].join('\n');

  const blocks = [
    block('/*', [
      `Content-Security-Policy: ${contentSecurityPolicy(config, "'none'", connectSrc, frameSrc)}`,
      ...common,
    ]),
    ...framable.map((pattern) =>
      block(pattern, [
        '! Content-Security-Policy',
        `Content-Security-Policy: ${contentSecurityPolicy(config, '*', connectSrc, frameSrc)}`,
      ]),
    ),
  ];
  return `${blocks.join('\n\n')}\n`;
}
