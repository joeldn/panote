import {
  canonicalLanguageTag,
  COMMON_LANGUAGES,
  languageName,
  MAX_TOUR_LANGUAGES,
  type TourLanguages,
} from '@internal/contracts';
import { Button } from '@internal/ui';
import { useEffect, useId, useRef, useState } from 'react';

// When a tour has never set a language, its text is taken to be in English until the
// author says otherwise (that is the language the app's own copy is in).
export const FALLBACK_LANGUAGE = 'en';
const OTHER = '__other';

export interface LanguageMenuProps {
  /** The tour's languages, if it has set any. */
  languages: TourLanguages | undefined;
  /** The language being edited. */
  editing: string;
  onEdit: (lang: string) => void;
  onChange: (languages: TourLanguages) => void;
  /** Asks to remove a translation (the editor confirms first). */
  onRemove: (lang: string) => void;
  onClose: () => void;
}

/** The top bar's language switcher (design README 6): pick, add and remove languages. */
export function LanguageMenu({
  languages,
  editing,
  onEdit,
  onChange,
  onRemove,
  onClose,
}: LanguageMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = languages ?? { default: FALLBACK_LANGUAGE, others: [] };
  const all = [current.default, ...current.others];
  const full = all.length >= MAX_TOUR_LANGUAGES;
  const addable = COMMON_LANGUAGES.filter((l) => !all.includes(l.tag));
  const [pick, setPick] = useState(addable[0]?.tag ?? OTHER);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      // A confirm modal over the editor is not "outside": it decides about this menu.
      if (
        ref.current &&
        target &&
        !ref.current.contains(target) &&
        !target.closest('[data-languages-toggle], [role="dialog"]')
      ) {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);

  const add = () => {
    const tag = pick === OTHER ? canonicalLanguageTag(typed) : pick;
    if (!tag) {
      setError('Use a language code such as de, pt-BR or zh-Hant.');
      return;
    }
    if (all.includes(tag)) {
      setError(`${languageName(tag)} is already in this tour.`);
      return;
    }
    setError(null);
    setTyped('');
    const next = addable.find((l) => l.tag !== tag && l.tag !== pick);
    setPick(next?.tag ?? OTHER);
    onChange({ default: current.default, others: [...current.others, tag] });
    onEdit(tag);
  };

  return (
    <div ref={ref} className="ed-popover ed-langs" role="dialog" aria-label="Languages">
      <h2 className="ed-popover__title">Languages</h2>
      <div className="ed-field">
        <label className="ed-label" htmlFor={`${id}-default`}>
          Written in
        </label>
        <select
          id={`${id}-default`}
          className="ed-input"
          value={current.default}
          onChange={(e) => onChange({ ...current, default: e.target.value })}
        >
          {[
            ...(COMMON_LANGUAGES.some((l) => l.tag === current.default)
              ? []
              : [{ tag: current.default, name: languageName(current.default) }]),
            ...COMMON_LANGUAGES,
          ]
            .filter((l) => !current.others.includes(l.tag))
            .map((l) => (
              <option key={l.tag} value={l.tag}>
                {l.name}
              </option>
            ))}
        </select>
        <p className="ed-note">The language your titles and text are written in.</p>
      </div>
      <ul className="ed-langs__list" aria-label="Edit in">
        {all.map((tag) => (
          <li key={tag} className="ed-langs__row">
            <button
              type="button"
              className="ed-langs__pick"
              aria-pressed={tag === editing}
              onClick={() => onEdit(tag)}
            >
              <span lang={tag}>{languageName(tag)}</span>
              {tag === current.default && <span className="ed-langs__badge">Default</span>}
            </button>
            {tag !== current.default && (
              <button
                type="button"
                className="ed-langs__remove"
                aria-label={`Remove ${languageName(tag)}`}
                onClick={() => onRemove(tag)}
              >
                <i className="fa-solid fa-xmark" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {full ? (
        <p className="ed-note">A tour can have up to {MAX_TOUR_LANGUAGES} languages.</p>
      ) : (
        <div className="ed-field ed-langs__add">
          <label className="ed-label" htmlFor={`${id}-add`}>
            Add a language
          </label>
          <div className="ed-langs__add-row">
            <select
              id={`${id}-add`}
              className="ed-input"
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                setError(null);
              }}
            >
              {addable.map((l) => (
                <option key={l.tag} value={l.tag}>
                  {l.name}
                </option>
              ))}
              <option value={OTHER}>Other…</option>
            </select>
            <Button variant="accent" size="sm" pill icon="fa-solid fa-plus" onClick={add}>
              Add
            </Button>
          </div>
          {pick === OTHER && (
            <>
              <label className="ed-sr" htmlFor={`${id}-tag`}>
                Language code
              </label>
              <input
                id={`${id}-tag`}
                className="ed-input"
                value={typed}
                placeholder="Language code, e.g. cy or es-419"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') add();
                }}
              />
            </>
          )}
          {error && (
            <p id={`${id}-error`} className="ed-note ed-note--error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
