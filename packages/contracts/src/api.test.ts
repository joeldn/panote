import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_DELETE_CONFIRMATION,
  AccountDeleteRequestSchema,
  AccountDeletionRecordSchema,
  AccountDisabledRecordSchema,
  TourOwnerRecordSchema,
  QuarantineCaseRecordSchema,
  CLIENT_ID_PATTERN,
  OperatorTakedownRequestSchema,
  OPERATOR_RESTORE_MAX_KEY_LENGTH,
  OperatorRestoreRequestSchema,
  PANO_DELETE_CONFLICTS,
  PanoConfigOkSchema,
  PanoDeleteConflictSchema,
  PanoStatusSchema,
  PanoSummarySchema,
  TourOkSchema,
} from './api.js';

describe('PanoConfigOkSchema canonicalizes legacy out-of-range angles/fov', () => {
  it('parses a legacy doc (fov 90, hotspot yaw 5, hotspot pitch 2) to canonical values', () => {
    const r = PanoConfigOkSchema.parse({
      etag: 'abc',
      config: {
        panoId: 'p1',
        title: 'Hall',
        initialView: { yaw: 0, pitch: 0, fov: 90 },
        hotspots: [{ id: 'h1', type: 'info', yaw: 5, pitch: 2, title: 'Info' }],
      },
    });
    expect(r.config.initialView?.fov).toBe(80);
    expect(r.config.hotspots[0]?.yaw).toBeCloseTo(5 - 2 * Math.PI);
    expect(r.config.hotspots[0]?.pitch).toBeCloseTo(Math.PI / 2);
  });
});

describe('TourOkSchema publish field', () => {
  const tour = { tourId: 't1', title: 'T', scenes: [] };
  it('accepts a response without publish (pre-B2), null, or a publish state', () => {
    expect(TourOkSchema.parse({ tour, etag: 'e' }).publish).toBeUndefined();
    expect(TourOkSchema.parse({ tour, etag: 'e', publish: null }).publish).toBeNull();
    const publish = {
      slug: 'tour',
      visibility: 'unlisted',
      publishedAt: '2026-09-27T00:00:00.000Z',
    };
    expect(TourOkSchema.parse({ tour, etag: 'e', publish }).publish).toEqual(publish);
  });
});

describe('TourOkSchema tour description', () => {
  it('carries the description when the tour has one, and parses tours without', () => {
    const tour = { tourId: 't1', title: 'T', scenes: [] };
    expect(TourOkSchema.parse({ tour, etag: 'e' }).tour.description).toBeUndefined();
    const described = { ...tour, description: 'Old town' };
    expect(TourOkSchema.parse({ tour: described, etag: 'e' }).tour.description).toBe('Old town');
  });
});

describe('PanoSummarySchema referenced field', () => {
  const pano = {
    panoId: 'p1',
    title: null,
    hasConfig: false,
    hasOriginal: true,
    deleting: false,
    tiling: 'ready',
    manifest: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  it('is optional, so a list without ?include=references still parses', () => {
    expect(PanoSummarySchema.parse(pano).referenced).toBeUndefined();
    expect(PanoSummarySchema.parse({ ...pano, referenced: false }).referenced).toBe(false);
  });
  it('is not part of the per-pano status', () => {
    expect('referenced' in PanoStatusSchema.shape).toBe(false);
  });
});

describe('PanoDeleteConflictSchema', () => {
  it('accepts every refusal the delete route sends, and nothing else', () => {
    for (const error of Object.values(PANO_DELETE_CONFLICTS)) {
      expect(PanoDeleteConflictSchema.safeParse({ error }).success).toBe(true);
    }
    expect(PanoDeleteConflictSchema.safeParse({ error: 'conflict' }).success).toBe(false);
  });
});

describe('AccountDeleteRequestSchema', () => {
  it('accepts only the exact confirmation phrase', () => {
    expect(
      AccountDeleteRequestSchema.safeParse({ confirm: ACCOUNT_DELETE_CONFIRMATION }).success,
    ).toBe(true);
    for (const confirm of ['Delete my account', 'delete my account ', '', undefined]) {
      expect(AccountDeleteRequestSchema.safeParse({ confirm }).success).toBe(false);
    }
  });
});

describe('AccountDeletionRecordSchema', () => {
  it('needs the sub, so the sweep can rebuild the owner keys', () => {
    const record = { v: 1, sub: 'auth0|abc', requestedAt: '2026-10-01T00:00:00.000Z' };
    expect(AccountDeletionRecordSchema.safeParse(record).success).toBe(true);
    expect(AccountDeletionRecordSchema.safeParse({ ...record, sub: '' }).success).toBe(false);
  });
});

describe('AccountDisabledRecordSchema', () => {
  it('needs a disabledAt; the reason is optional and bounded', () => {
    const record = { v: 1, disabledAt: '2026-10-01T00:00:00.000Z' };
    expect(AccountDisabledRecordSchema.safeParse(record).success).toBe(true);
    expect(AccountDisabledRecordSchema.safeParse({ ...record, reason: 'ticket 12' }).success).toBe(
      true,
    );
    expect(AccountDisabledRecordSchema.safeParse({ v: 1 }).success).toBe(false);
    expect(
      AccountDisabledRecordSchema.safeParse({ ...record, reason: 'x'.repeat(501) }).success,
    ).toBe(false);
  });
});

describe('TourOwnerRecordSchema', () => {
  it('needs a non-empty sub', () => {
    expect(TourOwnerRecordSchema.safeParse({ v: 1, sub: 'auth0|me' }).success).toBe(true);
    expect(TourOwnerRecordSchema.safeParse({ v: 1, sub: '' }).success).toBe(false);
  });
});

describe('QuarantineCaseRecordSchema', () => {
  it('needs the owner and the copied keys', () => {
    const record = {
      v: 1,
      caseId: 'c-1',
      sub: 'auth0|me',
      tourIds: ['t'],
      keys: ['k'],
      firstAt: 'a',
      lastAt: 'b',
    };
    expect(QuarantineCaseRecordSchema.safeParse(record).success).toBe(true);
    expect(QuarantineCaseRecordSchema.safeParse({ ...record, keys: 'k' }).success).toBe(false);
    expect(QuarantineCaseRecordSchema.safeParse({ ...record, sub: '' }).success).toBe(false);
  });
});

describe('CLIENT_ID_PATTERN', () => {
  it('takes what crypto.randomUUID() returns', () => {
    for (let i = 0; i < 20; i++) expect(CLIENT_ID_PATTERN.test(crypto.randomUUID())).toBe(true);
  });

  it.each([
    '',
    'anon-1',
    '6F9619FF-8B86-4D01-B42D-00CF4FC964FF',
    '6f9619ff-8b86-1d01-b42d-00cf4fc964ff',
    '6f9619ff-8b86-4d01-b42d-00cf4fc964ff ',
    '6f9619ff-8b86-4d01-b42d-00cf4fc964ff6f9619ff',
    '6f9619ff8b864d01b42d00cf4fc964ff',
  ])('refuses %j', (id) => {
    expect(CLIENT_ID_PATTERN.test(id)).toBe(false);
  });
});

describe('OperatorTakedownRequestSchema', () => {
  const ok = { sub: 'auth0|abc', tourId: 'tour-1', action: 'unpublish' };

  it('takes a sub, a tourId and one of the actions', () => {
    expect(OperatorTakedownRequestSchema.safeParse(ok).success).toBe(true);
    for (const action of ['delete', 'hide', 'unhide']) {
      expect(OperatorTakedownRequestSchema.safeParse({ ...ok, action }).success).toBe(true);
    }
  });

  it.each([
    ['an empty sub', { ...ok, sub: '' }],
    ['a tourId with a slash', { ...ok, tourId: 'a/b' }],
    ['another action', { ...ok, action: 'disable' }],
  ])('refuses %s', (_label, body) => {
    expect(OperatorTakedownRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('OperatorRestoreRequestSchema', () => {
  const key = 'tours/abc/t1/tour.json';
  it('takes a date and restorable keys, create-only by default', () => {
    const parsed = OperatorRestoreRequestSchema.parse({ date: '2026-10-22', keys: [key] });
    expect(parsed.overwrite).toBe(false);
  });

  it.each([
    { date: '2026-10-22/..', keys: [key] },
    { date: '2026-10-22', keys: [] },
    { date: '2026-10-22', keys: ['accounts/abc/deletion.json'] },
    { date: '2026-10-22', keys: ['panos/abc/p1/original'] },
    { date: '2026-10-22', keys: ['backup/2026-10-21/tours/abc/t1/tour.json'] },
    { date: '2026-10-22', keys: Array.from({ length: 101 }, () => key) },
    {
      date: '2026-10-22',
      keys: [`tours/abc/t1/${'x'.repeat(OPERATOR_RESTORE_MAX_KEY_LENGTH)}.json`],
    },
  ])('refuses %j', (body) => {
    expect(OperatorRestoreRequestSchema.safeParse(body).success).toBe(false);
  });
});
