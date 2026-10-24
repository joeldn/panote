import { Button, IconButton, Notice } from '@internal/ui';
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
    <Notice
      tone="error"
      icon="fa-solid fa-code-merge"
      className="ed-banner"
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={onReload} disabled={busy}>
            Reload
          </Button>
          <Button variant="danger" size="sm" onClick={onOverwrite} busy={busy}>
            Overwrite
          </Button>
        </>
      }
    >
      <strong>This tour changed elsewhere — reload or overwrite.</strong>
      <p>
        {conflicts.map((k) => docLabel(docs, k)).join(', ')}{' '}
        {conflicts.length === 1 ? 'was' : 'were'} saved somewhere else since you opened it. Reload
        to take that version and drop your changes to it, or overwrite it with yours.
      </p>
    </Notice>
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
    <Notice
      tone="error"
      icon="fa-solid fa-triangle-exclamation"
      className="ed-banner"
      actions={
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
      }
    >
      <strong>Some changes weren’t saved.</strong>
      <ul>
        {rows.map(([k, f]) => (
          <li key={k}>
            {docLabel(docs, k)}: {failureText(f)}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

export function Notices({
  notices,
  onDismiss,
  busy,
  onRepublish,
  onDiscardDraft,
  saving,
  failed,
}: {
  notices: EditorNotice[];
  onDismiss: (id: string) => void;
  busy: boolean;
  onRepublish: () => void;
  onDiscardDraft: () => void;
  /** A save is under way: discarding now would race it, publishing would catch it halfway. */
  saving: boolean;
  /** Some documents of the last save failed: publishing now would mix new and old. */
  failed: boolean;
}) {
  return (
    <>
      {notices.map((n) => (
        <Notice
          key={n.id}
          tone={n.tone}
          // Announced politely whatever the tone: these follow the user's own action.
          role="status"
          icon={`fa-solid ${n.tone === 'warn' ? 'fa-circle-exclamation' : 'fa-circle-info'}`}
          className="ed-banner"
          actions={
            <>
              {n.action === 'republish' && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={onRepublish}
                  busy={busy}
                  disabled={saving || failed}
                  title={saving || failed ? 'Save your changes first' : undefined}
                >
                  Try again
                </Button>
              )}
              {n.action === 'discard-draft' && (
                <Button variant="ghost" size="sm" onClick={onDiscardDraft} disabled={saving}>
                  Discard
                </Button>
              )}
              <IconButton
                icon="fa-solid fa-xmark"
                label="Dismiss"
                onClick={() => onDismiss(n.id)}
              />
            </>
          }
        >
          {n.text}{' '}
          {n.link && (
            <Link to={n.link.to} className="ed-banner__link">
              {n.link.label}
            </Link>
          )}
        </Notice>
      ))}
    </>
  );
}
