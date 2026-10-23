import { describe, it, expect } from 'vitest';
import {
  accountDeletionKey,
  accountDisabledKey,
  QUARANTINE_ROOT,
  tourOwnerKey,
  uploadLogKey,
  uploadLogTime,
  userUploadLogPrefix,
  configKey,
  deletingKey,
  originalKey,
  manifestKey,
  previewKey,
  ogKey,
  TILE_GC_ROOT,
  tileGcKey,
  tileGcPrefix,
  userPanosPrefix,
  tourKey,
  panoPrefix,
  encodeId,
  PANO_PATTERN,
  redactOwner,
  TILES_ROOT,
  tilesPrefix,
  tileVersionPrefix,
  tileFailedKey,
  tileFailedKeyFromOriginalKey,
  panoIdFromOriginalKey,
  BACKUP_PROGRESS_KEY,
  BACKUP_ROOT,
  BACKUP_SOURCES,
  backupCompleteKey,
  backupKey,
  backupSetPrefix,
  exploreEntryKey,
  exploreApprovedKey,
  exploreHiddenKey,
  explorePendingKey,
  exploreTourKey,
  flagIdOf,
  flagKey,
  isBackedUpKey,
  isRestorableKey,
  publishKey,
  planKey,
  pubTourKey,
  sharingStoppedKey,
  slugKey,
  tourIdOfPlanKey,
  trashDayPrefix,
  trashKey,
  isOriginalKey,
  decodeId,
} from './keys.js';

describe('keys', () => {
  it('builds a config key with an encoded (base64url) owner segment and a verbatim panoId', () => {
    expect(configKey('auth0|abc', 'p1')).toBe(`panos/${encodeId('auth0|abc')}/p1/config.json`);
  });
  it('encodes every sign-in provider sub to a distinct, URL-safe owner segment', () => {
    const subs = [
      'google-oauth2|111',
      'apple|000123.abc.4567',
      'windowslive|9f8e7d',
      'github|583231',
      'linkedin|AbC-123_x',
      'facebook|10220',
      'email|65f1c0de2a',
    ];
    const owners = subs.map(encodeId);
    expect(new Set(owners).size).toBe(subs.length);
    for (const [i, owner] of owners.entries()) {
      expect(owner).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(atob(owner.replace(/-/g, '+').replace(/_/g, '/'))).toBe(subs[i]);
      expect(tileFailedKeyFromOriginalKey(`panos/${owner}/p1/original`)).toBe(
        `panos/${owner}/p1/tile-failed`,
      );
    }
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

  it('builds an account deletion marker key under accounts/, owner encoded', () => {
    expect(accountDeletionKey('auth0|abc')).toBe(`accounts/${encodeId('auth0|abc')}/deletion.json`);
  });

  it('tourOwnerKey is owner-free and private (outside tiles/, pub/, slugs/)', () => {
    expect(tourOwnerKey('tour-1')).toBe('tour-owners/tour-1.json');
    expect(() => tourOwnerKey('a/b')).toThrow(/tourId must match/);
    expect(QUARANTINE_ROOT).toBe('quarantine/');
  });

  it('accountDisabledKey sits next to the deletion marker, owner encoded', () => {
    expect(accountDisabledKey('auth0|abc')).toBe(`accounts/${encodeId('auth0|abc')}/disabled.json`);
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

    it('previewKey nests preview.webp under the version dir, alongside the tiles', () => {
      expect(previewKey(panoId, 't1-abc123')).toBe(`tiles/${panoId}/t1-abc123/preview.webp`);
    });

    it('previewKey throws on an invalid panoId', () => {
      expect(() => previewKey('a/b', 't1-abc123')).toThrow(/panoId must match/);
    });

    it('previewKey throws on an invalid version', () => {
      expect(() => previewKey(panoId, 'v/1')).toThrow(/version must match/);
    });

    it('ogKey nests og.jpg under the version dir, alongside the tiles', () => {
      expect(ogKey(panoId, 't1-abc123')).toBe(`tiles/${panoId}/t1-abc123/og.jpg`);
    });

    it('ogKey throws on an invalid panoId or version', () => {
      expect(() => ogKey('a/b', 't1-abc123')).toThrow(/panoId must match/);
      expect(() => ogKey(panoId, 'v/1')).toThrow(/version must match/);
    });

    it('tileGcKey sits outside tiles/, so the CDN never serves a record', () => {
      expect(tileGcKey(panoId, 't1-abc123')).toBe(`tile-gc/${panoId}/t1-abc123.json`);
      expect(tileGcKey(panoId, 't1-abc123').startsWith(TILES_ROOT)).toBe(false);
      expect(tileGcKey(panoId, 't1-abc123').startsWith(TILE_GC_ROOT)).toBe(true);
      expect(tileGcKey(panoId, 't1-abc123').startsWith(tileGcPrefix(panoId))).toBe(true);
    });

    it('tileGcKey throws on an invalid panoId or version', () => {
      expect(() => tileGcKey('a/b', 't1-abc123')).toThrow(/panoId must match/);
      expect(() => tileGcKey(panoId, 'v/1')).toThrow(/version must match/);
    });
  });

  // The DLQ consumer only has the already-encoded owner segment, not the raw
  // sub - tileFailedKeyFromOriginalKey must land on the same key as tileFailedKey.
  describe('tile-failed marker key (unit B4)', () => {
    it('builds a marker key with an encoded owner segment and a verbatim panoId', () => {
      expect(tileFailedKey('auth0|abc', 'p1')).toBe(
        `panos/${encodeId('auth0|abc')}/p1/tile-failed`,
      );
    });

    it('tileFailedKey throws on an invalid panoId', () => {
      expect(() => tileFailedKey('u1', 'a/b')).toThrow(/panoId must match/);
    });

    it('tileFailedKeyFromOriginalKey derives the sibling marker key from a notification key, owner segment untouched', () => {
      expect(tileFailedKeyFromOriginalKey('panos/ae-_vTXvv70/p1/original')).toBe(
        'panos/ae-_vTXvv70/p1/tile-failed',
      );
    });

    it('agrees with tileFailedKey for the same owner/panoId (via originalKey, the real notification-key shape)', () => {
      const owner = 'auth0|me';
      const panoId = '550e8400-e29b-41d4-a716-446655440000';
      expect(tileFailedKeyFromOriginalKey(originalKey(owner, panoId))).toBe(
        tileFailedKey(owner, panoId),
      );
    });

    // Charset-invalid keys must not get a marker (review fix) - cheap to
    // validate here the same way deriveUploadTarget does upstream.
    it('throws on an owner segment with an invalid charset', () => {
      expect(() => tileFailedKeyFromOriginalKey('panos/own%25er/p1/original')).toThrow(
        /owner segment/,
      );
    });

    it.each([
      ['an invalid owner charset', 'panos/secret@example.com/p1/original'],
      ['an owner with a space', 'panos/secret owner/p1/original'],
      ['a bad shape', 'panos/secretowner/p1/extra/original'],
    ])('does not echo the key or owner segment on %s', (_label, key) => {
      expect(() => tileFailedKeyFromOriginalKey(key)).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('secret') }),
      );
      expect(() => panoIdFromOriginalKey(key)).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('secret') }),
      );
    });

    it('throws on a panoId segment with an invalid charset', () => {
      expect(() => tileFailedKeyFromOriginalKey('panos/owner/bad panoid/original')).toThrow(
        /panoId segment/,
      );
    });

    it.each([
      ['too few segments', 'panos/owner/original'],
      ['too many segments', 'panos/owner/p1/extra/original'],
      ['missing the panos/ prefix', 'tours/owner/p1/original'],
      ['missing the /original suffix', 'panos/owner/p1/config.json'],
    ])('throws on %s - nowhere valid to hang a marker', (_label, key) => {
      expect(() => tileFailedKeyFromOriginalKey(key)).toThrow();
    });

    // panoIdFromOriginalKey (unit B4's manifest race check) shares the same
    // parse/validation as tileFailedKeyFromOriginalKey - just the panoId.
    it('panoIdFromOriginalKey returns the panoId segment alone', () => {
      expect(panoIdFromOriginalKey('panos/ae-_vTXvv70/p1/original')).toBe('p1');
    });

    it('panoIdFromOriginalKey throws the same way as tileFailedKeyFromOriginalKey', () => {
      expect(() => panoIdFromOriginalKey('panos/owner/bad panoid/original')).toThrow(
        /panoId segment/,
      );
    });
  });
});

describe('upload log keys', () => {
  const at = new Date('2026-10-22T09:05:03.042Z');

  it('sits under upload-log/<owner>/, outside panos/, owner encoded', () => {
    expect(userUploadLogPrefix('auth0|abc')).toBe(`upload-log/${encodeId('auth0|abc')}/`);
    expect(uploadLogKey('auth0|abc', at, 'p1')).toBe(
      `upload-log/${encodeId('auth0|abc')}/20261022T090503042Z-p1`,
    );
  });

  it('has no character the S3 and binding paths could spell differently', () => {
    expect(uploadLogKey('auth0|abc', at, 'p1')).toMatch(/^[A-Za-z0-9_/-]+$/);
  });

  it('reads the issue time back from the name', () => {
    const key = uploadLogKey('auth0|abc', at, 'a-uuid-like-id');
    expect(uploadLogTime(key.slice(userUploadLogPrefix('auth0|abc').length))).toBe(at.getTime());
  });

  it.each(['', 'nonsense', '2026-10-22T09:05:03.042Z-p1', '20261022T0905Z-p1'])(
    'a malformed name (%j) has no time',
    (name) => {
      expect(uploadLogTime(name)).toBeNaN();
    },
  );

  it('refuses a panoId outside PANO_PATTERN', () => {
    expect(() => uploadLogKey('auth0|abc', at, 'a/b')).toThrow();
  });
});

describe('backup keys', () => {
  const sub = 'google-oauth2|111';
  it('puts a copy under its dated set, beside the set marker', () => {
    expect(backupKey('2026-10-22', tourKey(sub, 't1'))).toBe(
      `backup/2026-10-22/tours/${encodeId(sub)}/t1/tour.json`,
    );
    expect(backupCompleteKey('2026-10-22')).toBe('backup/2026-10-22/complete.json');
    expect(() => backupSetPrefix('2026-10-22/../x')).toThrow(/YYYY-MM-DD/);
  });

  it.each([
    tourKey(sub, 't1'),
    publishKey(sub, 't1'),
    sharingStoppedKey(sub, 't1'),
    configKey(sub, 'p1'),
    pubTourKey('t1'),
    slugKey('my-tour'),
    tourOwnerKey('t1'),
    exploreEntryKey(1_700_000_000_000, 't1'),
    exploreTourKey('t1'),
    exploreHiddenKey('t1'),
    exploreApprovedKey('t1'),
    explorePendingKey('t1'),
    accountDeletionKey(sub),
    accountDisabledKey(sub),
    planKey('t1', 'pl1', 'image/webp'),
    planKey('t1', 'pl1', 'image/jpeg'),
    planKey('t1', 'pl1', 'image/png'),
  ])('backs up %s', (key) => {
    expect(isBackedUpKey(key)).toBe(true);
  });

  it.each([
    originalKey(sub, 'p1'),
    deletingKey(sub, 'p1'),
    tileFailedKey(sub, 'p1'),
    manifestKey('p1'),
    previewKey('p1', 'v1'),
    tileGcKey('p1', 'v1'),
    uploadLogKey(sub, new Date(0), 'p1'),
    `${QUARANTINE_ROOT}case-1/${tourKey(sub, 't1')}`,
    'ops/dlq-alert/q.json',
    backupKey('2026-10-22', tourKey(sub, 't1')),
    BACKUP_PROGRESS_KEY,
    'pub/plans/t1/pl1.gif',
    'pub/plans/t1/nested/pl1.webp',
    'pub/plans/t1/',
  ])('leaves %s out', (key) => {
    expect(isBackedUpKey(key)).toBe(false);
  });

  it('restores plan images like any other public key', () => {
    expect(isRestorableKey(planKey('t1', 'pl1', 'image/png'))).toBe(true);
  });

  it('reads the tourId back from a plan image key, and only from one', () => {
    expect(tourIdOfPlanKey(planKey('t-1_a', 'pl1', 'image/webp'))).toBe('t-1_a');
    for (const key of [
      'pub/plans/t1/pl1.gif',
      'pub/plans/t1/a/pl1.webp',
      'pub/plans/t1.webp',
      pubTourKey('t1'),
      'pub/plans/../pl1.png',
    ]) {
      expect(tourIdOfPlanKey(key)).toBeNull();
    }
  });

  it('keeps trash outside every owner prefix, every public prefix and the backup', () => {
    const key = trashKey('2026-10-22', originalKey(sub, 'p1'));
    expect(key).toBe(`trash/2026-10-22/${originalKey(sub, 'p1')}`);
    expect(key.startsWith(userPanosPrefix(sub))).toBe(false);
    expect(key.startsWith('panos/')).toBe(false);
    expect(['tiles/', 'pub/', 'slugs/'].some((p) => key.startsWith(p))).toBe(false);
    expect(isBackedUpKey(key)).toBe(false);
    expect(trashDayPrefix('2026-10-22')).toBe('trash/2026-10-22/');
    expect(() => trashDayPrefix('2026-10-22/..')).toThrow();
  });

  it('decodes an owner segment back to the id, and nothing encodeId could not write', () => {
    for (const raw of ['auth0|abc', 'google-oauth2|1234', 'email|ünï ✓']) {
      expect(decodeId(encodeId(raw))).toBe(raw);
    }
    for (const bad of ['', 'a/b', 'YQ==', '_w', encodeId('x') + '%']) {
      expect(decodeId(bad)).toBeNull();
    }
  });

  it('knows an original key from anything else', () => {
    expect(isOriginalKey(originalKey(sub, 'p1'))).toBe(true);
    for (const k of [configKey(sub, 'p1'), 'panos/a b/p1/original', 'panos/abc/p.1/original']) {
      expect(isOriginalKey(k)).toBe(false);
    }
  });

  it('never restores the account markers', () => {
    expect(isRestorableKey(accountDeletionKey(sub))).toBe(false);
    expect(isRestorableKey(accountDisabledKey(sub))).toBe(false);
    expect(isRestorableKey(tourKey(sub, 't1'))).toBe(true);
  });

  it('lists each source prefix once, every match inside its prefix', () => {
    const prefixes = BACKUP_SOURCES.map((s) => s.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes.some((p) => p.startsWith(BACKUP_ROOT) || BACKUP_ROOT.startsWith(p))).toBe(
      false,
    );
  });
});

describe('redactOwner', () => {
  it('replaces the owner segment of every panos/ key in the text', () => {
    expect(
      redactOwner('R2 DELETE panos/ae-_vTXvv70/p1/tile-failed -> 403; also panos/x/p2/original'),
    ).toBe('R2 DELETE panos/<owner>/p1/tile-failed -> 403; also panos/<owner>/p2/original');
  });

  it('covers every owner-keyed root, including built keys', () => {
    const sub = 'google-oauth2|123';
    const owner = encodeId(sub);
    for (const key of [
      originalKey(sub, 'p1'),
      tourKey(sub, 't1'),
      accountDeletionKey(sub),
      accountDisabledKey(sub),
      uploadLogKey(sub, new Date(0), 'p1'),
    ]) {
      const redacted = redactOwner(`R2 PUT ${key} -> 500`);
      expect(redacted).not.toContain(owner);
      expect(redacted).toContain('/<owner>/');
    }
  });

  it('redacts keys inside URLs and backup or quarantine copies', () => {
    expect(redactOwner('PUT https://a.r2.cloudflarestorage.com/b/tours/abc/t1/tour.json')).toBe(
      'PUT https://a.r2.cloudflarestorage.com/b/tours/<owner>/t1/tour.json',
    );
    expect(redactOwner(`${BACKUP_ROOT}2026-01-01/accounts/abc/deletion.json`)).toBe(
      `${BACKUP_ROOT}2026-01-01/accounts/<owner>/deletion.json`,
    );
    expect(redactOwner(`${QUARANTINE_ROOT}case1/panos/abc/p1/original`)).toBe(
      `${QUARANTINE_ROOT}case1/panos/<owner>/p1/original`,
    );
    // A case id that is also a route word doesn't hide the key after it.
    for (const caseId of ['api', 'admin', 'app', 'pub', 'explore']) {
      expect(redactOwner(`${QUARANTINE_ROOT}${caseId}/tours/abc/t1/tour.json`)).toBe(
        `${QUARANTINE_ROOT}${caseId}/tours/<owner>/t1/tour.json`,
      );
    }
  });

  it('redacts an owner with spaces, @ or %, up to the next slash', () => {
    expect(redactOwner('HEAD panos/a b/p1/original failed')).toBe(
      'HEAD panos/<owner>/p1/original failed',
    );
    expect(redactOwner('panos/joel@example.com/p1/original')).toBe('panos/<owner>/p1/original');
    expect(redactOwner('upload-log/secret%owner/x')).toBe('upload-log/<owner>/x');
  });

  it('stops at one segment and never crosses a line break', () => {
    expect(redactOwner('panos/a b/p1/original and tiles/p1/x')).toBe(
      'panos/<owner>/p1/original and tiles/p1/x',
    );
    expect(redactOwner('panos/no slash here\nnext line /x')).toBe(
      'panos/no slash here\nnext line /x',
    );
  });

  it('leaves owner-free keys and routes alone', () => {
    for (const text of [
      'R2 PUT tiles/p1/t1-abc/0/px/0-0.webp -> 500',
      'GET /api/tours/t1/stats',
      'PUT /api/admin/tours/t1/slug',
      'at /app/panos/unused/x',
      'pub/tours/t1.json',
      'explore/tours/t1.json',
      'contours/a/b',
    ])
      expect(redactOwner(text)).toBe(text);
  });

  it('is linear on adversarial input', () => {
    const started = performance.now();
    redactOwner('panos/'.repeat(20_000));
    redactOwner(`panos/${'a'.repeat(100_000)}`);
    redactOwner(`${'api/tours/'.repeat(10_000)}x`);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('flag keys', () => {
  it('lists newest first and names the flag back', () => {
    const older = flagKey(1_700_000_000_000, 'f-old');
    const newer = flagKey(1_700_000_000_001, 'f-new');
    expect(newer < older).toBe(true);
    expect(older).toMatch(/^moderation\/flags\/\d{13}-f-old\.json$/);
    expect(flagIdOf(older)).toBe('f-old');
    expect(flagIdOf('moderation/flags/x.json')).toBeNull();
    expect(() => flagKey(0, '../x')).toThrow();
  });
});
