import { describe, expect, it } from 'vitest';

import { ConfigError, KNOWN_CONNECTIONS, loadConfig, tilesBaseUrl } from './config.js';

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
      VITE_AUTH0_CONNECTIONS: 'google-oauth2, twitter,apple,google-oauth2',
    });
    expect(c.auth0.connections).toEqual(['google-oauth2', 'apple']);
  });

  it('shows the social providers in a fixed order, then email, whatever the env order', () => {
    const c = loadConfig({
      ...env,
      VITE_AUTH0_CONNECTIONS: 'email,facebook,windowslive,twitter,apple,google-oauth2,facebook',
    });
    expect(c.auth0.connections).toEqual([
      'google-oauth2',
      'apple',
      'windowslive',
      'facebook',
      'email',
    ]);
    expect(
      loadConfig({ ...env, VITE_AUTH0_CONNECTIONS: 'facebook, windowslive' }).auth0.connections,
    ).toEqual(['windowslive', 'facebook']);
  });

  it('labels each social connection by its provider with a brand icon, and email apart', () => {
    expect(KNOWN_CONNECTIONS).toEqual({
      'google-oauth2': { label: 'Google', icon: 'fa-brands fa-google', kind: 'social' },
      apple: { label: 'Apple', icon: 'fa-brands fa-apple', kind: 'social' },
      windowslive: { label: 'Microsoft', icon: 'fa-brands fa-microsoft', kind: 'social' },
      facebook: { label: 'Facebook', icon: 'fa-brands fa-facebook', kind: 'social' },
      email: { label: 'email', icon: 'fa-solid fa-envelope', kind: 'email' },
    });
  });

  it('accepts email on its own', () => {
    expect(loadConfig({ ...env, VITE_AUTH0_CONNECTIONS: 'email' }).auth0.connections).toEqual([
      'email',
    ]);
  });

  it('does not offer GitHub or LinkedIn sign-in', () => {
    expect(
      loadConfig({ ...env, VITE_AUTH0_CONNECTIONS: 'google-oauth2,github,linkedin' }).auth0
        .connections,
    ).toEqual(['google-oauth2']);
    expect(() => loadConfig({ ...env, VITE_AUTH0_CONNECTIONS: 'linkedin, github' })).toThrow(
      ConfigError,
    );
  });

  it('rejects a connection list with no known connection (Twitter is not one)', () => {
    expect(() => loadConfig({ ...env, VITE_AUTH0_CONNECTIONS: 'twitter' })).toThrow(ConfigError);
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

  it.each([
    ['', ''],
    ['/', ''],
    ['/proxy/', '/proxy'],
    ['https://panote.dev/', 'https://panote.dev'],
    ['http://localhost:8787', 'http://localhost:8787'],
  ])('accepts VITE_API_BASE %j', (value, out) => {
    expect(loadConfig({ ...env, VITE_API_BASE: value }).apiBase).toBe(out);
  });

  it.each(['api', 'panote.dev/api', '//evil.example', 'ftp://panote.dev', 'javascript:alert(1)'])(
    'rejects VITE_API_BASE %j',
    (value) => {
      expect(() => loadConfig({ ...env, VITE_API_BASE: value })).toThrow(/VITE_API_BASE/);
    },
  );

  it('rejects VITE_AUTH0_CONNECTIONS that names no known connection', () => {
    expect(() => loadConfig({ ...env, VITE_AUTH0_CONNECTIONS: 'twitter, sms' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...env, VITE_AUTH0_CONNECTIONS: '' })).toThrow(
      /VITE_AUTH0_CONNECTIONS/,
    );
  });
});
