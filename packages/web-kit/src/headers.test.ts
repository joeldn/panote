import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { buildHeadersFile, contentSecurityPolicy } from './headers.js';

const env = {
  VITE_SITE_ORIGIN: 'https://panote.dev',
  VITE_CDN_BASE: 'https://cdn.panote.dev/',
  VITE_AUTH0_DOMAIN: 'panote-dev.au.auth0.com',
  VITE_AUTH0_CLIENT_ID: 'YOUR_DEV_SPA_CLIENT_ID',
  VITE_AUTH0_AUDIENCE: 'https://api.panote.dev',
};

describe('contentSecurityPolicy', () => {
  it('allows only self, the CDN, Auth0 and the extra origins', () => {
    const csp = contentSecurityPolicy(loadConfig(env), "'none'", [
      'https://acct.r2.cloudflarestorage.com/bucket/key?x=1',
    ]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("img-src 'self' https://cdn.panote.dev data: blob:");
    expect(csp).toContain(
      "connect-src 'self' https://cdn.panote.dev https://acct.r2.cloudflarestorage.com https://panote-dev.au.auth0.com;",
    );
    expect(csp).toContain('frame-src https://www.youtube-nocookie.com;');
    expect(csp).toMatch(/frame-ancestors 'none'$/);
  });

  it('allows hotspot video from the CDN only', () => {
    const csp = contentSecurityPolicy(loadConfig(env), "'none'");
    expect(csp).toContain("media-src 'self' https://cdn.panote.dev;");
    // YouTube hotspots render through the privacy-enhanced host, nothing else frames.
    expect(csp).toMatch(/frame-src https:\/\/www\.youtube-nocookie\.com;/);
    expect(csp).not.toContain('youtube.com ');
  });

  it('skips a placeholder Auth0 domain and adds a cross-origin API base', () => {
    const csp = contentSecurityPolicy(
      loadConfig({
        ...env,
        VITE_AUTH0_DOMAIN: 'YOUR_PROD_TENANT.auth0.com',
        VITE_API_BASE: 'https://api.example.com/v1',
      }),
      '*',
    );
    expect(csp).not.toMatch(/YOUR_/);
    expect(csp).toContain("connect-src 'self' https://cdn.panote.dev https://api.example.com;");
  });
});

describe('buildHeadersFile', () => {
  it('denies framing everywhere except the framable patterns', () => {
    const file = buildHeadersFile(loadConfig(env), {
      framable: ['/s/:slug/embed', '/s/:slug/embed/'],
    });
    const [all, embed, embedSlash, ...rest] = file.trimEnd().split('\n\n');
    expect(rest).toEqual([]);
    expect(embedSlash).toMatch(/^\/s\/:slug\/embed\/\n {2}! Content-Security-Policy\n/);
    expect(embedSlash).toMatch(/frame-ancestors \*$/);
    expect(all).toMatch(/^\/\*\n {2}Content-Security-Policy: .*frame-ancestors 'none'\n/);
    expect(all).toContain('  X-Content-Type-Options: nosniff');
    expect(embed).toMatch(
      /^\/s\/:slug\/embed\n {2}! Content-Security-Policy\n {2}Content-Security-Policy: .*frame-ancestors \*$/,
    );
  });

  it('adds extra frame-src sources only when asked', () => {
    expect(buildHeadersFile(loadConfig(env))).not.toContain("frame-src 'self'");
    const file = buildHeadersFile(loadConfig(env), { frameSrc: ["'self'"] });
    expect(file).toContain("frame-src 'self' https://www.youtube-nocookie.com;");
  });

  it('emits a single block with no framable paths', () => {
    expect(buildHeadersFile(loadConfig(env)).trimEnd().split('\n\n')).toHaveLength(1);
  });

  it('adds noindex only when asked', () => {
    expect(buildHeadersFile(loadConfig(env))).not.toContain('X-Robots-Tag');
    expect(buildHeadersFile(loadConfig(env), { noindex: true })).toMatch(
      /^\/\*\n(?: {2}.*\n)* {2}X-Robots-Tag: noindex\n/,
    );
  });
});
