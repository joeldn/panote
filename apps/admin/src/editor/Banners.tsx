import { Button } from '@internal/ui';
import { Link } from 'react-router';

import { docLabel, type DocKey, type EditorDocs } from './model.js';
import type { DocFailure } from './save.js';
import type { EditorNotice, Failures } from './use-editor.js';

const failureText = (f: DocFailure): string => {
  switch (f.kind) {
    case 'conflict':
      return 'changed elsewhere';
    case 'auth':
      return 'sign in again to save';
    case 'invalid':
    case 'error':
      return f.message;
  }
};

export interface ConflictBannerProps {
  docs: EditorDocs;
  conflicts: DocKey[];
  busy: boolean;
  onReload: () => void;
  onOverwrite: () => void;
}

/** Shown on a 412: someone saved this tour (another tab, another device) since it was loaded. */
export function ConflictBanner({
  docs,
  conflicts,
  busy,
  onReload,
  onOverwrite,
}: ConflictBannerProps) {
  return (
    <div className="ed-banner ed-banner--conflict" role="alert">
      <i className="fa-solid fa-code-merge ed-banner__icon" aria-hidden="true" />
      <div className="ed-banner__text">
        <strong>This tour changed elsewhere — reload or overwrite.</strong>
        <span>
          {conflicts.map((k) => docLabel(docs, k)).join(', ')}{' '}
          {conflicts.length === 1 ? 'was' : 'were'} saved somewhere else since you opened it. Reload
          to take that version and drop your changes to it, or overwrite it with yours.
        </span>
      </div>
      <div className="ed-banner__actions">
        <Button variant="ghost" size="sm" onClick={onReload} disabled={busy}>
          Reload
        </Button>
        <Button variant="danger" size="sm" onClick={onOverwrite} busy={busy}>
          Overwrite
        </Button>
      </div>
    </div>
  );
}

export function ErrorBanner({
  docs,
  failures,
  busy,
  blocked,
  onRetry,
}: {
  docs: EditorDocs;
  failures: Failures;
  busy: boolean;
  /** A conflict is open: saving waits until it's resolved from the conflict banner. */
  blocked: boolean;
  onRetry: () => void;
}) {
  const rows = (Object.entries(failures) as Array<[DocKey, DocFailure]>).filter(
    ([, f]) => f.kind !== 'conflict',
  );
  if (rows.length === 0) return null;
  return (
    <div className="ed-banner ed-banner--error" role="alert">
      <i className="fa-solid fa-triangle-exclamation ed-banner__icon" aria-hidden="true" />
      <div className="ed-banner__text">
        <strong>Some changes weren’t saved.</strong>
        <ul>
          {rows.map(([k, f]) => (
            <li key={k}>
              {docLabel(docs, k)}: {failureText(f)}
            </li>
          ))}
        </ul>
      </div>
      <div className="ed-banner__actions">
        <Button
          variant="primary"
          size="sm"
          onClick={onRetry}
          busy={busy}
          disabled={blocked}
          title={blocked ? 'Resolve the conflict first' : undefined}
        >
          Try again
        </Button>
      </div>
    </div>
  );
}

export function Notices({
  notices,
  onDismiss,
  busy,
  onRepublish,
}: {
  notices: EditorNotice[];
  onDismiss: (id: string) => void;
  busy: boolean;
  onRepublish: () => void;
}) {
  return (
    <>
      {notices.map((n) => (
        <div key={n.id} className={`ed-banner ed-banner--${n.tone}`} role="status">
          <i
            className={`fa-solid ${n.tone === 'warn' ? 'fa-circle-exclamation' : 'fa-circle-info'} ed-banner__icon`}
            aria-hidden="true"
          />
          <p className="ed-banner__text">
            {n.text}{' '}
            {n.link && (
              <Link to={n.link.to} className="ed-banner__link">
                {n.link.label}
              </Link>
            )}
          </p>
          {n.action === 'republish' && (
            <Button variant="primary" size="sm" onClick={onRepublish} busy={busy}>
              Try again
            </Button>
          )}
          <button
            type="button"
            className="ed-icon-btn"
            aria-label="Dismiss"
            onClick={() => onDismiss(n.id)}
          >
            <i className="fa-solid fa-xmark" aria-hidden="true" />
          </button>
        </div>
      ))}
    </>
  );
}
