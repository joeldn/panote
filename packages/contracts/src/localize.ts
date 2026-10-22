import { tourLanguageList, type TourLanguages } from './languages.js';
import type { PublishedTour } from './publish.js';
import type { Hotspot, SceneConfig } from './schema.js';

// Reading translations (Q4): a field's text in one language, falling back to the
// default-language text the field itself holds when there is no translation.

type Translations<K extends string> = Partial<
  Record<string, { [F in K]?: string | undefined } | undefined>
>;

/** `base` in `lang`: its translation when there is one, else `base` itself. */
export function translated<K extends string>(
  base: string,
  i18n: Translations<K> | undefined,
  lang: string | null | undefined,
  field: K,
): string;
export function translated<K extends string>(
  base: string | undefined,
  i18n: Translations<K> | undefined,
  lang: string | null | undefined,
  field: K,
): string | undefined;
export function translated<K extends string>(
  base: string | undefined,
  i18n: Translations<K> | undefined,
  lang: string | null | undefined,
  field: K,
): string | undefined {
  if (!lang || !i18n) return base;
  return i18n[lang]?.[field] || base;
}

/** A hotspot with its title and body in `lang`. Keeps `i18n` (an editor may still want it). */
export function localizeHotspot(h: Hotspot, lang: string | null | undefined): Hotspot {
  if (!lang || !h.i18n?.[lang]) return h;
  const title = translated(h.title, h.i18n, lang, 'title');
  const body = translated(h.body, h.i18n, lang, 'body');
  return { ...h, title, ...(body !== undefined && { body }) };
}

/**
 * A scene config with its text in `lang`. A link with no translation of its own that still
 * carries its target's default title (the editor names a new link after the scene it goes
 * to) takes the target's translated title, found through `targetTitle`.
 */
export function localizeSceneConfig(
  config: SceneConfig,
  lang: string | null | undefined,
  targetTitle?: (panoId: string) => { base: string; translated: string } | undefined,
): SceneConfig {
  if (!lang) return config;
  const description = translated(config.description, config.i18n, lang, 'description');
  return {
    ...config,
    title: translated(config.title, config.i18n, lang, 'title'),
    ...(description !== undefined && { description }),
    hotspots: config.hotspots.map((h) => {
      const own = localizeHotspot(h, lang);
      if (own !== h || h.type !== 'link' || h.targetPanoId === undefined) return own;
      const target = targetTitle?.(h.targetPanoId);
      return target && h.title === target.base ? { ...h, title: target.translated } : h;
    }),
  };
}

/** Configs keyed by panoId, each with its text in `lang` (links follow their targets). */
export function localizeConfigs<C extends SceneConfig>(
  configs: ReadonlyMap<string, C>,
  lang: string | null | undefined,
): Map<string, SceneConfig> {
  const out = new Map<string, SceneConfig>();
  const targetTitle = (panoId: string) => {
    const c = configs.get(panoId);
    return c && { base: c.title, translated: translated(c.title, c.i18n, lang, 'title') };
  };
  for (const [panoId, c] of configs) out.set(panoId, localizeSceneConfig(c, lang, targetTitle));
  return out;
}

/** A published bundle with its title, description and every scene's text in `lang`. */
export function localizePublishedTour(
  pub: PublishedTour,
  lang: string | null | undefined,
): PublishedTour {
  if (!lang || lang === pub.languages?.default) return pub;
  const configs = localizeConfigs(new Map(pub.scenes.map((s) => [s.panoId, s.config])), lang);
  const description = translated(pub.description, pub.i18n, lang, 'description');
  return {
    ...pub,
    title: translated(pub.title, pub.i18n, lang, 'title'),
    ...(description !== undefined && { description }),
    scenes: pub.scenes.map((s) => ({ ...s, config: configs.get(s.panoId) ?? s.config })),
  };
}

/** Translations kept to `keep`; undefined when none are left, so the key can be dropped. */
export function pickTranslations<T>(
  i18n: Partial<Record<string, T>> | undefined,
  keep: ReadonlySet<string>,
): Record<string, T> | undefined {
  if (!i18n) return undefined;
  const entries = Object.entries(i18n).filter(
    (e): e is [string, T] => keep.has(e[0]) && e[1] !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** The languages a translation may be kept for: the tour's, minus its default. */
export const translationLanguages = (languages: TourLanguages | undefined): Set<string> =>
  new Set(tourLanguageList(languages).slice(1));
