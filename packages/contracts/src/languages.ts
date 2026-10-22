import { z } from 'zod';

// Tour content languages (Q4). A tour's text is written in its default language; the
// others are translations an author adds. App chrome is not translated.

/** Default language plus translations: a tour has at most this many languages. */
export const MAX_TOUR_LANGUAGES = 10;

// A practical BCP 47 subset, in canonical case: a 2-3 letter language, then an optional
// script (Hant) and an optional region (BR, or 419 for a UN M49 area). Enough for every
// language a tour author would pick, and short enough to sit in a URL and a JSON key.
export const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

/**
 * The canonical form of a typed tag (`pt-br` → `pt-BR`), or null when it is not one the
 * schema accepts. Intl canonicalises where it can (it also maps deprecated codes, e.g.
 * `iw` → `he`); the pattern is the gate either way.
 */
export function canonicalLanguageTag(raw: string): string | null {
  const trimmed = raw.trim().replace(/_/g, '-');
  if (!trimmed) return null;
  let tag: string;
  try {
    tag = Intl.getCanonicalLocales(trimmed)[0] ?? trimmed;
  } catch {
    return null;
  }
  return LANGUAGE_TAG_PATTERN.test(tag) ? tag : null;
}

export const LanguageTagSchema = z
  .string()
  .regex(LANGUAGE_TAG_PATTERN, `language must be a BCP 47 tag like en or pt-BR`)
  .refine((t) => canonicalLanguageTag(t) === t, 'language tag must be in canonical form');

export const TourLanguagesSchema = z
  .object({
    /** The language the tour's own fields (title, body, …) are written in. */
    default: LanguageTagSchema,
    /** Translations, in the order the author added them. */
    others: z.array(LanguageTagSchema).max(MAX_TOUR_LANGUAGES - 1),
  })
  .superRefine((l, ctx) => {
    const seen = new Set([l.default]);
    l.others.forEach((tag, i) => {
      if (seen.has(tag)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${tag} is listed twice`,
          path: ['others', i],
        });
      }
      seen.add(tag);
    });
  });
export type TourLanguages = z.infer<typeof TourLanguagesSchema>;

/** Every language of a tour, default first; empty for a tour that never set any. */
export const tourLanguageList = (languages: TourLanguages | undefined): string[] =>
  languages ? [languages.default, ...languages.others] : [];

/**
 * The common languages the editor offers, by their own (native) names. Anything else
 * can still be typed as a tag; `languageName` names it through Intl where it can.
 */
export const COMMON_LANGUAGES: ReadonlyArray<{ tag: string; name: string }> = [
  { tag: 'en', name: 'English' },
  { tag: 'es', name: 'Español' },
  { tag: 'fr', name: 'Français' },
  { tag: 'de', name: 'Deutsch' },
  { tag: 'it', name: 'Italiano' },
  { tag: 'pt', name: 'Português' },
  { tag: 'pt-BR', name: 'Português (Brasil)' },
  { tag: 'nl', name: 'Nederlands' },
  { tag: 'ca', name: 'Català' },
  { tag: 'sv', name: 'Svenska' },
  { tag: 'da', name: 'Dansk' },
  { tag: 'nb', name: 'Norsk bokmål' },
  { tag: 'fi', name: 'Suomi' },
  { tag: 'pl', name: 'Polski' },
  { tag: 'cs', name: 'Čeština' },
  { tag: 'hu', name: 'Magyar' },
  { tag: 'ro', name: 'Română' },
  { tag: 'hr', name: 'Hrvatski' },
  { tag: 'el', name: 'Ελληνικά' },
  { tag: 'tr', name: 'Türkçe' },
  { tag: 'ru', name: 'Русский' },
  { tag: 'uk', name: 'Українська' },
  { tag: 'ar', name: 'العربية' },
  { tag: 'he', name: 'עברית' },
  { tag: 'hi', name: 'हिन्दी' },
  { tag: 'th', name: 'ไทย' },
  { tag: 'vi', name: 'Tiếng Việt' },
  { tag: 'id', name: 'Bahasa Indonesia' },
  { tag: 'ja', name: '日本語' },
  { tag: 'ko', name: '한국어' },
  { tag: 'zh-Hans', name: '简体中文' },
  { tag: 'zh-Hant', name: '繁體中文' },
];

/** A language's own name for itself (`de` → Deutsch), falling back to the tag. */
export function languageName(tag: string): string {
  const known = COMMON_LANGUAGES.find((l) => l.tag === tag);
  if (known) return known.name;
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    if (name && name !== tag) return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
  } catch {
    // Not a tag Intl knows: the tag is the best name there is.
  }
  return tag;
}

const primary = (tag: string): string => tag.split('-')[0]!.toLowerCase();

/** A tag's likely script (`zh-TW` → Hant, `sr` → Cyrl), or null when Intl can't tell. */
function scriptOf(tag: string): string | null {
  try {
    return new Intl.Locale(tag).maximize().script ?? null;
  } catch {
    return null;
  }
}

/**
 * The tour language that serves a wanted tag. In order: an exact match (ignoring case);
 * the wanted tag cut back one subtag at a time (`zh-Hant-TW` → `zh-Hant`); a language
 * with the same primary subtag written in the same script (`zh-TW` → `zh-Hant`, `zh-CN`
 * → `zh-Hans`, `sr` → `sr-Cyrl`), the bare language first (`pt-PT` → `pt` over `pt-BR`);
 * then the bare language; then any language with the same primary subtag.
 */
export function matchLanguage(available: readonly string[], wanted: string): string | null {
  const want = wanted.trim().replace(/_/g, '-').toLowerCase();
  if (!want) return null;
  const find = (tag: string) => available.find((a) => a.toLowerCase() === tag);
  const parts = want.split('-');
  for (let n = parts.length; n >= 2; n--) {
    const hit = find(parts.slice(0, n).join('-'));
    if (hit) return hit;
  }
  const p = parts[0]!;
  const same = available.filter((a) => primary(a) === p);
  const script = scriptOf(want);
  if (script) {
    const scripted = same.filter((a) => scriptOf(a) === script);
    const hit = scripted.find((a) => a.toLowerCase() === p) ?? scripted[0];
    if (hit) return hit;
  }
  return find(p) ?? same[0] ?? null;
}

/**
 * The language a visitor sees: `?lang=` when the tour has it, else their browser's
 * languages in their order (each exact, then by primary subtag), else the default.
 * Null for a tour without languages (its text is shown as stored).
 */
export function pickLanguage(
  languages: TourLanguages | undefined,
  requested: string | null | undefined,
  preferred: readonly string[] = [],
): string | null {
  const available = tourLanguageList(languages);
  if (available.length === 0) return null;
  if (requested) {
    const hit = matchLanguage(available, requested);
    if (hit) return hit;
  }
  for (const want of preferred) {
    const hit = matchLanguage(available, want);
    if (hit) return hit;
  }
  return available[0]!;
}
