import { describe, it, expect } from 'vitest';
import {
  configKey,
  deletingKey,
  originalKey,
  manifestKey,
  userPanosPrefix,
  tourKey,
  panoPrefix,
  encodeId,
  PANO_PATTERN,
  TILES_ROOT,
  tilesPrefix,
  tileVersionPrefix,
} from './keys.js';

describe('keys', () => {
  it('builds a config key with an encoded (base64url) owner segment and a verbatim panoId', () => {
    expect(configKey('auth0|abc', 'p1')).toBe(`panos/${encodeId('auth0|abc')}/p1/config.json`);
  });
  it('builds a list prefix', () => {
    expect(userPanosPrefix('auth0|abc')).toBe(`panos/${encodeId('auth0|abc')}/`);
  });

  // The delete tombstone: same owner-scoped shape as configKey/originalKey,
  // so a leftover from an interrupted delete still proves ownership.
  it('builds a deleting (tombstone) key with an encoded owner segment and a verbatim panoId', () => {
    expect(deletingKey('auth0|abc', 'p1')).toBe(`panos/${encodeId('auth0|abc')}/p1/deleting`);
  });
  it('deletingKey throws on an invalid panoId', () => {
    expect(() => deletingKey('u1', 'a/b')).toThrow(/panoId must match/);
  });

  describe('encodeId (owner only)', () => {
    it('produces only URL-unreserved characters', () => {
      const inputs = [
        '',
        'a',
        'auth0|me',
        'probe pano|1',
        'a/b',
        '100%',
        'a%2Fb',
        'a+b',
        'ünïcøde',
        '日本語',
        '😀',
        "~!*()'-._",
        '../other-user',
        't/1',
      ];
      for (const raw of inputs) {
        expect(encodeId(raw)).toMatch(/^[A-Za-z0-9_-]*$/);
      }
    });

    it('never contains "=" padding', () => {
      expect(encodeId('a')).not.toContain('=');
      expect(encodeId('ab')).not.toContain('=');
      expect(encodeId('auth0|me')).not.toContain('=');
    });
  });

  // panoId/tourId are never encoded (see keys.ts); PANO_PATTERN validation
  // is what keeps them key-safe instead.
  describe('panoId/tourId: verbatim + validated, never encoded', () => {
    it('uses a valid panoId verbatim, not encoded', () => {
      const panoId = '550e8400-e29b-41d4-a716-446655440000';
      expect(configKey('u1', panoId)).toBe(`panos/${encodeId('u1')}/${panoId}/config.json`);
      expect(panoPrefix('u1', panoId)).toContain(`/${panoId}/`);
    });

    it('uses a valid tourId verbatim, not encoded', () => {
      const tourId = 'my-tour_1';
      expect(tourKey('u1', tourId)).toBe(`tours/${encodeId('u1')}/${tourId}/tour.json`);
    });

    it.each(['a/b', '../other-user', 'probe pano|1', 'slash/probe/1', 'ünïcøde', '100%', ''])(
      'panoPrefix throws on an invalid panoId %j',
      (invalid) => {
        expect(() => panoPrefix('u1', invalid)).toThrow(/panoId must match/);
      },
    );
    it.each(['a/b', 't/1', 'probe tour|1', 'ünïcøde', ''])(
      'tourKey throws on an invalid tourId %j',
      (invalid) => {
        expect(() => tourKey('u1', invalid)).toThrow(/tourId must match/);
      },
    );

    it('originalKey/configKey all throw on an invalid panoId', () => {
      expect(() => originalKey('u1', 'a/b')).toThrow(/panoId must match/);
      expect(() => configKey('u1', 'a/b')).toThrow(/panoId must match/);
    });

    it('PANO_PATTERN matches the charset panoId/tourId are restricted to', () => {
      expect(PANO_PATTERN.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(PANO_PATTERN.test('a/b')).toBe(false);
      expect(PANO_PATTERN.test('')).toBe(false);
    });
  });

  // Tiles/manifest are public-CDN-served and carry no owner segment;
  // panoId alone is the key.
  describe('tile and manifest keys: owner-free', () => {
    const panoId = '550e8400-e29b-41d4-a716-446655440000';

    it('TILES_ROOT is the fixed "tiles/" root', () => {
      expect(TILES_ROOT).toBe('tiles/');
    });

    it('tilesPrefix builds an owner-free prefix from panoId alone', () => {
      expect(tilesPrefix(panoId)).toBe(`tiles/${panoId}/`);
    });

    it('tilesPrefix throws on an invalid panoId', () => {
      expect(() => tilesPrefix('a/b')).toThrow(/panoId must match/);
    });

    it('tileVersionPrefix nests the version under tilesPrefix', () => {
      expect(tileVersionPrefix(panoId, 't1-abc123')).toBe(`tiles/${panoId}/t1-abc123/`);
    });

    it('tileVersionPrefix throws on an invalid panoId', () => {
      expect(() => tileVersionPrefix('a/b', 't1-abc123')).toThrow(/panoId must match/);
    });

    it('tileVersionPrefix throws on an invalid version', () => {
      expect(() => tileVersionPrefix(panoId, 'v/1')).toThrow(/version must match/);
    });

    it('manifestKey takes panoId alone and builds an owner-free key', () => {
      expect(manifestKey(panoId)).toBe(`tiles/${panoId}/manifest.json`);
    });

    it('manifestKey throws on an invalid panoId', () => {
      expect(() => manifestKey('a/b')).toThrow(/panoId must match/);
    });
  });
});
