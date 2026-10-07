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
}

/** Click to edit; Enter or blur commits, Escape cancels. Blank input keeps the old value. */
export function InlineText({ value, onCommit, label, className, disabled }: InlineTextProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next && next !== value) onCommit(next);
  };

  if (draft === null) {
    return (
      <button
        type="button"
        className={`ed-inline ${className ?? ''}`}
        aria-label={disabled ? `${label}: ${value}` : `${label}: ${value}. Click to edit`}
        disabled={disabled}
        onClick={() => setDraft(value)}
      >
        {value}
      </button>
    );
  }
  return (
    <input
      className={`ed-inline ed-inline--editing ${className ?? ''}`}
      aria-label={label}
      value={draft}
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
