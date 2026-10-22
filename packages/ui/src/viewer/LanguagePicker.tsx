import { languageName } from '@internal/contracts';

import { cx } from '../cx.js';

export interface LanguagePickerProps {
  /** The tour's languages, default first. */
  languages: readonly string[];
  value: string;
  onChange: (lang: string) => void;
  className?: string;
}

/**
 * The visitor's language picker: each language by its own name. Renders nothing for a
 * tour in one language, so a host can always mount it.
 */
export function LanguagePicker({ languages, value, onChange, className }: LanguagePickerProps) {
  if (languages.length < 2) return null;
  return (
    <label className={cx('pn-lang', className)}>
      <i className="fa-solid fa-globe" aria-hidden="true" />
      <span className="pn-sr-only">Language</span>
      <select className="pn-lang__select" value={value} onChange={(e) => onChange(e.target.value)}>
        {languages.map((tag) => (
          <option key={tag} value={tag} lang={tag}>
            {languageName(tag)}
          </option>
        ))}
      </select>
    </label>
  );
}
