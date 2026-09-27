import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, tilesBaseUrl } from './config.js';

const env = {
  VITE_SITE_ORIGIN: 'https://panote.dev/',
  VITE_CDN_BASE: 'https://cdn.panote.dev',
  VITE_AUTH0_DOMAIN: 'https://YOUR_TENANT.auth0.com/',
  VITE_AUTH0_CLIENT_ID: 'YOUR_SPA_CLIENT_ID',
  VITE_AUTH0_AUDIENCE: 'https://api.panote.dev',
};

describe('loadConfig', () => {
  it('normalises origins and bases', () => {
    const c = loadConfig(env);
    expect(c.siteOrigin).toBe('https://panote.dev');
    expect(c.cdnBase).toBe('https://cdn.panote.dev/');
    expect(tilesBaseUrl(c)).toBe('https://cdn.panote.dev/tiles/');
    expect(c.apiBase).toBe('');
    expect(c.auth0.domain).toBe('YOUR_TENANT.auth0.com');
    expect(c.showcaseSlug).toBeNull();
  });

  it('defaults to Google-only sign-in and drops unknown connections', () => {
    expect(loadConfig(env).auth0.connections).toEqual(['google-oauth2']);
    const c = loadConfig({
      ...env,
      VITE_AUTH0_CONNECTIONS: 'google-oauth2, github,apple,google-oauth2',
    });
    expect(c.auth0.connections).toEqual(['google-oauth2', 'apple']);
  });

  it('flags YOUR_ placeholders as not configured', () => {
    expect(loadConfig(env).auth0.configured).toBe(false);
    const real = loadConfig({
      ...env,
      VITE_AUTH0_DOMAIN: 'tenant.example.auth0.com',
      VITE_AUTH0_CLIENT_ID: 'abc123',
    });
    expect(real.auth0.configured).toBe(true);
  });

  it('throws ConfigError naming each bad key', () => {
    const err = (() => {
      try {
        loadConfig({ ...env, VITE_CDN_BASE: 'not a url', VITE_AUTH0_CLIENT_ID: '' });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).issues.join('\n')).toMatch(/VITE_CDN_BASE/);
    expect((err as ConfigError).issues.join('\n')).toMatch(/VITE_AUTH0_CLIENT_ID/);
  });
});
