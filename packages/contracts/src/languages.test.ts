import { describe, expect, it } from 'vitest';

import {
  canonicalLanguageTag,
  COMMON_LANGUAGES,
  languageName,
  matchLanguage,
  MAX_TOUR_LANGUAGES,
  pickLanguage,
  TourLanguagesSchema,
} from './languages.js';
import {
  localizePublishedTour,
  localizeSceneConfig,
  pickTranslations,
  translated,
} from './localize.js';
import { PublishedTourSchema } from './publish.js';
import {
  MAX_SCENE_TRANSLATION_CHARS,
  MAX_TITLE_LENGTH,
  SceneConfigSchema,
  TourDocSchema,
} from './schema.js';

describe('language tags', () => {
  it('canonicalises what an author types, and refuses what is not a tag', () => {
    expect(canonicalLanguageTag('pt-br')).toBe('pt-BR');
    expect(canonicalLanguageTag(' zh_hant ')).toBe('zh-Hant');
    expect(canonicalLanguageTag('es-419')).toBe('es-419');
    expect(canonicalLanguageTag('english')).toBeNull();
    expect(canonicalLanguageTag('en-US-x-private')).toBeNull();
    expect(canonicalLanguageTag('')).toBeNull();
  });

  it('every curated language is a canonical tag with its own name', () => {
    for (const { tag, name } of COMMON_LANGUAGES) {
      expect(canonicalLanguageTag(tag)).toBe(tag);
      expect(languageName(tag)).toBe(name);
    }
    expect(new Set(COMMON_LANGUAGES.map((l) => l.tag)).size).toBe(COMMON_LANGUAGES.length);
  });

  it('names an uncurated tag through Intl, else by the tag', () => {
    expect(languageName('cy')).toMatch(/^Cymraeg$/i);
    expect(languageName('qqq')).toBe('qqq');
  });

  it('accepts a default plus translations, up to the cap, with no repeats', () => {
    expect(TourLanguagesSchema.safeParse({ default: 'en', others: ['de', 'pt-BR'] }).success).toBe(
      true,
    );
    const many = COMMON_LANGUAGES.slice(1, MAX_TOUR_LANGUAGES + 1).map((l) => l.tag);
    expect(TourLanguagesSchema.safeParse({ default: 'en', others: many }).success).toBe(false);
    expect(
      TourLanguagesSchema.safeParse({ default: 'en', others: many.slice(0, -1) }).success,
    ).toBe(true);
    expect(TourLanguagesSchema.safeParse({ default: 'en', others: ['en'] }).success).toBe(false);
    expect(TourLanguagesSchema.safeParse({ default: 'en', others: ['pt-br'] }).success).toBe(false);
  });
});

describe('pickLanguage', () => {
  const langs = { default: 'en', others: ['de', 'pt-BR', 'pt'] };

  it('takes ?lang= when the tour has it, case-insensitively', () => {
    expect(pickLanguage(langs, 'DE', ['pt'])).toBe('de');
    expect(pickLanguage(langs, 'de-AT', [])).toBe('de');
  });

  it("falls back to the browser's languages in order, exact before primary subtag", () => {
    expect(pickLanguage(langs, 'xx', ['fr', 'pt-BR'])).toBe('pt-BR');
    expect(pickLanguage(langs, null, ['pt-PT'])).toBe('pt');
    expect(pickLanguage(langs, null, ['de-CH', 'pt'])).toBe('de');
  });

  it('else the default; null for a tour with no languages', () => {
    expect(pickLanguage(langs, null, ['ja'])).toBe('en');
    expect(pickLanguage(undefined, 'de', ['de'])).toBeNull();
  });

  it('matchLanguage finds nothing for an empty or unknown tag', () => {
    expect(matchLanguage(['en'], '')).toBeNull();
    expect(matchLanguage(['en', 'de'], 'fr-FR')).toBeNull();
  });
});

describe('translations in the schemas', () => {
  const scene = {
    panoId: 'p1',
    title: 'Hall',
    hotspots: [
      {
        id: 'h1',
        type: 'info',
        yaw: 0,
        pitch: 0,
        title: 'Door',
        i18n: { de: { title: 'Tür', body: 'Alte Tür' } },
      },
    ],
    i18n: { de: { title: 'Halle' } },
  };

  it('keeps scene, hotspot and tour translations', () => {
    const c = SceneConfigSchema.parse(scene);
    expect(c.i18n).toEqual({ de: { title: 'Halle' } });
    expect(c.hotspots[0]!.i18n).toEqual({ de: { title: 'Tür', body: 'Alte Tür' } });
    const t = TourDocSchema.parse({
      tourId: 't1',
      title: 'Old Town',
      languages: { default: 'en', others: ['de'] },
      i18n: { de: { title: 'Altstadt', description: '  Drei Plätze  ' } },
    });
    expect(t.i18n).toEqual({ de: { title: 'Altstadt', description: 'Drei Plätze' } });
  });

  it('a tour or config saved before languages existed still parses', () => {
    expect(SceneConfigSchema.safeParse({ panoId: 'p1', title: 'Hall' }).success).toBe(true);
    const t = TourDocSchema.parse({ tourId: 't1', title: 'Old Town' });
    expect(t).not.toHaveProperty('languages');
  });

  it('refuses a bad language key, an empty or over-long string, and too many languages', () => {
    const withI18n = (i18n: unknown) => SceneConfigSchema.safeParse({ ...scene, i18n }).success;
    expect(withI18n({ German: { title: 'Halle' } })).toBe(false);
    expect(withI18n({ de: { title: '' } })).toBe(false);
    expect(withI18n({ de: { title: 'x'.repeat(MAX_TITLE_LENGTH + 1) } })).toBe(false);
    const tooMany = Object.fromEntries(
      COMMON_LANGUAGES.slice(0, MAX_TOUR_LANGUAGES).map((l) => [l.tag, { title: 'x' }]),
    );
    expect(withI18n(tooMany)).toBe(false);
  });

  it('caps all the translated text in one scene config together', () => {
    // Each body is within its own cap; together they are over the scene's.
    const body = 'x'.repeat(19_000);
    const langs = COMMON_LANGUAGES.slice(1, MAX_TOUR_LANGUAGES).map((l) => l.tag);
    const hotspot = (id: string) => ({
      id,
      type: 'info',
      yaw: 0,
      pitch: 0,
      title: 'Door',
      i18n: Object.fromEntries(langs.map((l) => [l, { body }])),
    });
    const per = body.length * langs.length;
    const fits = Math.floor(MAX_SCENE_TRANSLATION_CHARS / per);
    const ok = {
      panoId: 'p1',
      title: 'Hall',
      hotspots: [...Array(fits).keys()].map((i) => hotspot(`h${i}`)),
    };
    expect(SceneConfigSchema.safeParse(ok).success).toBe(true);
    const over = { ...ok, hotspots: [...ok.hotspots, hotspot('one-more')] };
    expect(SceneConfigSchema.safeParse(over).success).toBe(false);
  });
});

describe('localizing', () => {
  it('falls back to the default text where a translation is missing', () => {
    expect(translated('Hall', { de: { title: 'Halle' } }, 'de', 'title')).toBe('Halle');
    expect(translated('Hall', { de: {} }, 'de', 'title')).toBe('Hall');
    expect(translated('Hall', undefined, 'de', 'title')).toBe('Hall');
    expect(translated('Hall', { de: { title: 'Halle' } }, null, 'title')).toBe('Hall');
  });

  it("a link without its own translation follows its target's translated title", () => {
    const config = SceneConfigSchema.parse({
      panoId: 'p1',
      title: 'Hall',
      hotspots: [
        { id: 'l1', type: 'link', yaw: 0, pitch: 0, title: 'Garden', targetPanoId: 'p2' },
        { id: 'l2', type: 'link', yaw: 1, pitch: 0, title: 'Way out', targetPanoId: 'p2' },
      ],
    });
    const out = localizeSceneConfig(config, 'de', () => ({ base: 'Garden', translated: 'Garten' }));
    expect(out.hotspots.map((h) => h.title)).toEqual(['Garten', 'Way out']);
  });

  it('localizes a whole published bundle, and leaves it be in the default language', () => {
    const pub = PublishedTourSchema.parse({
      v: 1,
      tourId: 't1',
      title: 'Old Town',
      description: 'Three squares',
      visibility: 'unlisted',
      slug: 'old-town',
      publishedAt: '2026-01-01T00:00:00.000Z',
      settings: { controls: 'bottom', showMap: true, showCompass: true, autoRotate: false },
      startPanoId: 'p1',
      languages: { default: 'en', others: ['de'] },
      i18n: { de: { title: 'Altstadt' } },
      scenes: [
        {
          panoId: 'p1',
          config: {
            panoId: 'p1',
            title: 'Hall',
            i18n: { de: { title: 'Halle' } },
            hotspots: [
              {
                id: 'h1',
                type: 'info',
                yaw: 0,
                pitch: 0,
                title: 'Door',
                body: 'Old door',
                i18n: { de: { body: 'Alte Tür' } },
              },
            ],
          },
        },
      ],
    });
    const de = localizePublishedTour(pub, 'de');
    expect(de.title).toBe('Altstadt');
    expect(de.description).toBe('Three squares');
    expect(de.scenes[0]!.config.title).toBe('Halle');
    expect(de.scenes[0]!.config.hotspots[0]).toMatchObject({ title: 'Door', body: 'Alte Tür' });
    expect(localizePublishedTour(pub, 'en')).toBe(pub);
  });

  it('a bundle published before languages parses and localizes to itself', () => {
    const old = PublishedTourSchema.parse({
      v: 1,
      tourId: 't1',
      title: 'Old Town',
      visibility: 'unlisted',
      slug: 'old-town',
      publishedAt: '2026-01-01T00:00:00.000Z',
      settings: { controls: 'bottom', showMap: true, showCompass: true, autoRotate: false },
      startPanoId: 'p1',
      scenes: [{ panoId: 'p1', config: { panoId: 'p1', title: 'Hall', hotspots: [] } }],
    });
    expect(localizePublishedTour(old, null)).toBe(old);
  });

  it('pickTranslations keeps only the given languages', () => {
    expect(pickTranslations({ de: 1, fr: 2 }, new Set(['de']))).toEqual({ de: 1 });
    expect(pickTranslations({ fr: 2 }, new Set(['de']))).toBeUndefined();
    expect(pickTranslations(undefined, new Set(['de']))).toBeUndefined();
  });
});
