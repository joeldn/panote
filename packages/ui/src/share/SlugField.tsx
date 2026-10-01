import { checkSlug, normalizeSlug, SLUG_MAX_LENGTH } from '@internal/contracts';
import { useId, useRef, useState, type KeyboardEvent } from 'react';

import { typingSlug } from './links.js';

export interface SlugFieldProps {
  /** Current slug; null when the tour has none yet. */
  slug: string | null;
  /** Shown before the input while editing, e.g. `panote.io/s/`. */
  prefix: string;
  /** Saves a normalised, valid slug. A rejection's message is shown inline. */
  onCommit: (slug: string) => Promise<void>;
  /** Start in edit mode (a tour that has to pick a slug). */
  startEditing?: boolean;
}

const INVALID_MESSAGE = `Use 3–${SLUG_MAX_LENGTH} lowercase letters, numbers or dashes.`;
const RESERVED_MESSAGE = 'That link is reserved. Try another.';

/** "Custom link:" row. Enter or blur commits, Escape cancels (design README 8). */
export function SlugField({ slug, prefix, onCommit, startEditing = false }: SlugFieldProps) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(slug ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Guards against the blur that follows Enter/Escape, and re-sending a draft that just failed.
  const settling = useRef(false);
  const lastFailed = useRef<string | null>(null);
  const inFlight = useRef(false);
  const errorId = useId();

  const start = () => {
    setDraft(slug ?? '');
    setError(null);
    lastFailed.current = null;
    setEditing(true);
  };

  const cancel = () => {
    settling.current = true;
    setDraft(slug ?? '');
    setError(null);
    setEditing(false);
  };

  const commit = async () => {
    if (settling.current || inFlight.current) return;
    const next = normalizeSlug(draft);
    if (next === slug) {
      setDraft(next);
      setError(null);
      setEditing(false);
      return;
    }
    // Nothing typed yet for a tour that has no slug: not an error, keep waiting.
    if (next === '' && slug === null) return;
    const check = checkSlug(next);
    if (!check.ok) {
      setDraft(next);
      setError(check.reason === 'reserved' ? RESERVED_MESSAGE : INVALID_MESSAGE);
      return;
    }
    if (next === lastFailed.current) return;
    setDraft(next);
    setError(null);
    setBusy(true);
    inFlight.current = true;
    try {
      await onCommit(next);
      lastFailed.current = null;
      settling.current = true;
      setEditing(false);
    } catch (e) {
      lastFailed.current = next;
      setError(e instanceof Error ? e.message : 'Could not save that link.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      // Escape only cancels the edit; the modal stays open.
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  if (!editing) {
    return (
      <div className="pn-share__slug">
        <span className="pn-share__slug-label">Custom link:</span>
        <button
          type="button"
          className="pn-share__slug-value"
          aria-label="Edit custom link"
          onClick={() => {
            settling.current = false;
            start();
          }}
        >
          / {slug ?? 'choose a link'}
          <i className="fa-solid fa-pencil" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div className="pn-share__slug-wrap">
      <div className="pn-share__slug">
        <span className="pn-share__slug-label">Custom link:</span>
        <span className="pn-share__slug-prefix" aria-hidden="true">
          {prefix}
        </span>
        <input
          className="pn-share__slug-input"
          aria-label="Custom link"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          aria-busy={busy || undefined}
          value={draft}
          maxLength={SLUG_MAX_LENGTH}
          readOnly={busy}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          onChange={(e) => {
            setDraft(typingSlug(e.target.value));
            setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => void commit()}
        />
        <button
          type="button"
          className="pn-share__slug-save"
          disabled={busy}
          // Keep focus in the input so its blur doesn't commit a second time.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void commit()}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error && (
        <p id={errorId} className="pn-share__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
