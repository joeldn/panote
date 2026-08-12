import { describe, it, expect } from 'vitest';
import {
  configKey,
  originalKey,
  manifestKey,
  userPanosPrefix,
  parseOwnerFromKey,
  tourKey,
  encUser,
  decUser,
} from './keys.js';

describe('keys', () => {
  it('builds a config key with encoded user', () => {
    expect(configKey('auth0|abc', 'p1')).toBe('panos/auth0%7Cabc/p1/config.json');
  });
  it('builds a list prefix', () => {
    expect(userPanosPrefix('auth0|abc')).toBe('panos/auth0%7Cabc/');
  });
  it('round-trips owner from an original key', () => {
    expect(parseOwnerFromKey(originalKey('auth0|abc', 'p1'))).toEqual({
      userId: 'auth0|abc',
      panoId: 'p1',
    });
  });
  it('returns null for an unrelated key', () => {
    expect(parseOwnerFromKey('tours/x/y/tour.json')).toBeNull();
  });

  // panoId/tourId get the same encodeURIComponent treatment userId already
  // gets, so a "/" (or other URL-significant character) in either can't
  // introduce an extra key segment and collide with, or escape into, a
  // different prefix in the R2 layout.
  describe('panoId/tourId encoding', () => {
    it('encodes a "/" in panoId so it cannot add an extra key segment', () => {
      expect(configKey('u1', 'a/b')).toBe('panos/u1/a%2Fb/config.json');
      expect(manifestKey('u1', '../other-user')).toBe('panos/u1/..%2Fother-user/manifest.json');
    });

    it('encodes a "/" in tourId so it cannot add an extra key segment', () => {
      expect(tourKey('u1', 't/1')).toBe('tours/u1/t%2F1/tour.json');
    });

    it('round-trips an owner whose panoId needed encoding', () => {
      expect(parseOwnerFromKey(originalKey('auth0|abc', 'a/b'))).toEqual({
        userId: 'auth0|abc',
        panoId: 'a/b',
      });
    });

    // Table-driven over inputs that specifically stress the characters plain
    // string equality would miss: "/" and "%" (the two that motivated this
    // encoding in the first place), "+" (meaningful in query strings but not
    // path segments), unicode/emoji (multi-byte), and the empty string.
    it.each([
      '',
      'a',
      'probe pano|1',
      'a/b',
      '100%',
      'a%2Fb',
      'a+b',
      'auth0|me',
      'ünïcøde',
      '日本語',
      '😀',
      "~!*()'-._",
    ])('decUser is the exact inverse of encUser for %j', (raw) => {
      expect(decUser(encUser(raw))).toBe(raw);
    });

    // decUser must be total: a raw (never-encoded) legacy key segment, such
    // as one written directly to the shared R2 bucket by pano-viewer's
    // crud-worker, can contain a "%" that is not valid percent-encoding.
    // decodeURIComponent() throws on that input; decUser must not.
    it.each(['100%bad', '%', '%zz', '%2', '%E0%A4%A'])(
      'decUser returns %j unchanged instead of throwing on invalid percent-encoding',
      (invalid) => {
        expect(decUser(invalid)).toBe(invalid);
      },
    );
  });
});
