import { MAX_TITLE_LENGTH } from '@internal/contracts';
import { useState } from 'react';

export interface InlineTextProps {
  value: string;
  onCommit: (value: string) => void;
  /** Accessible name of the field, e.g. "Tour title". */
  label: string;
  className?: string;
  /** Read-only for now (shown, not editable). */
  disabled?: boolean;
  /**
   * Shown while `value` is blank: a translation shows the default-language text. With
   * one, a blank commit is allowed (it clears the translation).
   */
  placeholder?: string;
}

/**
 * Click to edit; Enter or blur commits, Escape cancels. Blank input keeps the old value,
 * unless there is a placeholder to fall back on.
 */
export function InlineText({
  value,
  onCommit,
  label,
  className,
  disabled,
  placeholder,
}: InlineTextProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if ((next || placeholder !== undefined) && next !== value) onCommit(next);
  };

  if (draft === null) {
    const shown = value || placeholder || '';
    return (
      <button
        type="button"
        className={`ed-inline ${value ? '' : 'ed-inline--placeholder '}${className ?? ''}`}
        aria-label={disabled ? `${label}: ${shown}` : `${label}: ${shown}. Click to edit`}
        disabled={disabled}
        onClick={() => setDraft(value)}
      >
        {shown}
      </button>
    );
  }
  return (
    <input
      className={`ed-inline ed-inline--editing ${className ?? ''}`}
      aria-label={label}
      value={draft}
      {...(placeholder !== undefined && { placeholder })}
      maxLength={MAX_TITLE_LENGTH}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}
