import { describe, expect, it } from 'vitest';

import {
  appOrigins,
  callbackUrl,
  isAdminPath,
  returnTarget,
  signInPath,
  type AppOrigins,
} from './app-links.js';
import { safeReturnTo } from './auth.js';

const deployed: AppOrigins = { website: 'https://panote.dev', admin: 'https://panote.dev' };
const local: AppOrigins = { website: 'http://localhost:5174', admin: 'http://localhost:5173' };

describe('appOrigins', () => {
  it('uses the site origin for both apps when deployed', () => {
    expect(appOrigins('https://panote.dev/', false)).toEqual(deployed);
    expect(callbackUrl(deployed)).toBe('https://panote.dev/app/callback');
  });

  it('splits the apps across the vite dev ports locally', () => {
    expect(appOrigins('https://panote.dev', true)).toEqual(local);
    expect(callbackUrl(local)).toBe('http://localhost:5173/app/callback');
  });
});

describe('signInPath', () => {
  it('opens the modal, with or without a return path', () => {
    expect(signInPath()).toBe('/?signin=1');
    expect(signInPath('/app/t/abc')).toBe('/?signin=1&next=%2Fapp%2Ft%2Fabc');
  });

  it('round-trips a query flag the landing drop target can resume from (Q1)', () => {
    const url = new URL(signInPath('/app/new?resume=upload&x=1#top'), 'https://panote.dev');
    const next = url.searchParams.get('next');
    expect(next).toBe('/app/new?resume=upload&x=1#top');
    expect(safeReturnTo(next, deployed.admin)).toBe('/app/new?resume=upload&x=1#top');
  });
});

describe('returnTarget', () => {
  it('keeps admin paths in the router, relative to the /app basename', () => {
    expect(returnTarget('/app/', local)).toEqual({ kind: 'admin', path: '/' });
    expect(returnTarget('/app', local)).toEqual({ kind: 'admin', path: '/' });
    expect(returnTarget('/app?x=1', local)).toEqual({ kind: 'admin', path: '/?x=1' });
    expect(returnTarget('/app/new?resume=1', local)).toEqual({
      kind: 'admin',
      path: '/new?resume=1',
    });
  });

  it('sends anything else to the website origin', () => {
    expect(returnTarget('/s/tour?x=1', local)).toEqual({
      kind: 'website',
      url: 'http://localhost:5174/s/tour?x=1',
    });
    expect(returnTarget('/apple', deployed)).toEqual({
      kind: 'website',
      url: 'https://panote.dev/apple',
    });
  });

  it('isAdminPath does not match lookalike prefixes', () => {
    expect(isAdminPath('/application')).toBe(false);
    expect(isAdminPath('/app#x')).toBe(true);
  });
});
