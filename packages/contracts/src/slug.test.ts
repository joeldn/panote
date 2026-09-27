import { describe, expect, it } from 'vitest';

import { pubTourKey, publishKey, slugKey, encodeId, SLUGS_ROOT, storedSlugKey } from './keys.js';
import { PublishedTourSchema, SlugRecordSchema, SlugSchema } from './publish.js';
import {
  checkSlug,
  defaultSlugCandidates,
  normalizeSlug,
  randomSlugSuffix,
  RESERVED_SLUGS,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
} from './slug.js';

describe('normalizeSlug', () => {
  it('lowercases, replaces other characters with -, collapses and trims dashes', () => {
    expect(normalizeSlug('  My Great Tour!! ')).toBe('my-great-tour');
    expect(normalizeSlug('--A__b--c--')).toBe('a-b-c');
    expect(normalizeSlug('Café Olé')).toBe('caf-ol');
    expect(normalizeSlug('***')).toBe('');
  });

  it('is idempotent', () => {
    const once = normalizeSlug('Hello   World 2026');
    expect(normalizeSlug(once)).toBe(once);
  });
});

describe('checkSlug', () => {
  it('accepts 3-40 char lowercase slugs that start and end alphanumeric', () => {
    expect(checkSlug('abc')).toEqual({ ok: true });
    expect(checkSlug('a'.repeat(40))).toEqual({ ok: true });
    expect(checkSlug('my-tour-2')).toEqual({ ok: true });
  });

  it('rejects bad shapes as invalid', () => {
    for (const s of ['ab', 'a'.repeat(41), '-abc', 'abc-', 'ABC', 'a_b_c', 'a b c', '']) {
      expect(checkSlug(s)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('rejects every reserved word as reserved when it is otherwise valid', () => {
    for (const r of RESERVED_SLUGS) {
      if (SLUG_PATTERN.test(r)) expect(checkSlug(r)).toEqual({ ok: false, reason: 'reserved' });
      else expect(checkSlug(r).ok).toBe(false);
    }
    expect(checkSlug('admin')).toEqual({ ok: false, reason: 'reserved' });
  });

  it('SlugSchema reports the reason', () => {
    const r = SlugSchema.safeParse('panote');
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('reserved slug');
    expect(SlugSchema.safeParse('my-tour').success).toBe(true);
  });
});

describe('defaultSlugCandidates', () => {
  const rand = () => 'zz9zz9';

  it('tries the title slug, then -2..-9, then a random suffix', () => {
    expect(defaultSlugCandidates('Beach House', rand)).toEqual([
      'beach-house',
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `beach-house-${n}`),
      'beach-house-zz9zz9',
    ]);
  });

  it('falls back to tour-<random> for an empty, too-short or reserved title', () => {
    expect(defaultSlugCandidates('!!!', rand)).toEqual(['tour-zz9zz9']);
    expect(defaultSlugCandidates('ab', rand)).toEqual(['tour-zz9zz9']);
    expect(defaultSlugCandidates('Admin', rand)).toEqual(['tour-zz9zz9']);
  });

  it('keeps every candidate within the length limit and valid', () => {
    const long = 'A very long title that goes on - and on and on and on forever';
    for (const c of defaultSlugCandidates(long, rand)) {
      expect(c.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
      expect(checkSlug(c)).toEqual({ ok: true });
    }
  });

  it('random suffixes are 6 lowercase alphanumerics', () => {
    expect(randomSlugSuffix()).toMatch(/^[a-z0-9]{6}$/);
  });
});

describe('share-link keys', () => {
  it('builds owner-free public keys', () => {
    expect(pubTourKey('t1')).toBe('pub/tours/t1.json');
    expect(slugKey('my-tour')).toBe(`${SLUGS_ROOT}my-tour.json`);
  });

  it('builds the private publish sidecar under the encoded owner', () => {
    expect(publishKey('auth0|abc', 't1')).toBe(`tours/${encodeId('auth0|abc')}/t1/publish.json`);
  });

  it('builds a stored-slug key without re-validating, but refuses traversal', () => {
    expect(storedSlugKey('admin')).toBe('slugs/admin.json');
    expect(storedSlugKey('my-tour')).toBe('slugs/my-tour.json');
    for (const bad of ['../x', 'a/b', '', 'A', 'x'.repeat(65)])
      expect(storedSlugKey(bad)).toBeNull();
  });

  it('refuses an invalid or reserved slug and a bad tourId', () => {
    expect(() => slugKey('../x')).toThrow();
    expect(() => slugKey('api')).toThrow();
    expect(() => pubTourKey('../t')).toThrow();
  });
});

describe('share-link documents', () => {
  it('parses both slug record kinds', () => {
    expect(SlugRecordSchema.parse({ v: 1, kind: 'tour', tourId: 't1' }).kind).toBe('tour');
    const alias = {
      v: 1,
      kind: 'redirect',
      tourId: 't1',
      redirect: 'new-slug',
      expiresAt: '2026-10-01T00:00:00.000Z',
    };
    expect(SlugRecordSchema.parse(alias)).toEqual(alias);
  });

  it('parses a published tour bundle', () => {
    const bundle = {
      v: 1,
      tourId: 't1',
      title: 'Tour',
      visibility: 'unlisted',
      slug: 'tour',
      publishedAt: '2026-10-01T00:00:00.000Z',
      settings: { controls: 'bottom', showMap: true, showCompass: true, autoRotate: false },
      startPanoId: 'p1',
      scenes: [{ panoId: 'p1', config: { panoId: 'p1', title: 'Hall', hotspots: [] } }],
    };
    expect(PublishedTourSchema.parse(bundle).scenes).toHaveLength(1);
  });

  it("rejects a bundle with unsafe ids or a scene carrying another pano's config", () => {
    const bundle = {
      v: 1,
      tourId: 't1',
      title: 'Tour',
      visibility: 'public',
      slug: 'tour',
      publishedAt: '2026-10-01T00:00:00.000Z',
      settings: { controls: 'bottom', showMap: true, showCompass: true, autoRotate: false },
      startPanoId: 'p1',
      scenes: [{ panoId: 'p1', config: { panoId: 'p1', title: 'Hall', hotspots: [] } }],
    };
    const scene = (panoId: string, configId: string) => ({
      panoId,
      config: { panoId: configId, title: 'Hall', hotspots: [] },
    });
    const bad = [
      { ...bundle, tourId: '../t1' },
      { ...bundle, startPanoId: 'p1/../x' },
      { ...bundle, scenes: [scene('../p1', '../p1')] },
      { ...bundle, scenes: [scene('p1', 'p2')] },
    ];
    for (const b of bad) expect(PublishedTourSchema.safeParse(b).success).toBe(false);
  });
});
