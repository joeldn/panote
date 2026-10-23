import { FLAG_REASONS, MAX_FLAG_NOTE_LENGTH, type FlagReason } from '@internal/contracts';
import { Button, Modal, useModalTitleId } from '@internal/ui';
import { createPublicApi } from '@internal/web-kit';
import { useId, useMemo, useState } from 'react';

import { useConfig } from '../config-context.js';
import { reportHref } from './report.js';

/** What each reason reads as on the page, in FLAG_REASONS order. */
const FLAG_REASON_LABELS: Record<FlagReason, string> = {
  sexual: 'Sexual or nude content',
  'child-safety': 'Puts a child at risk',
  violence: 'Violence or gore',
  hate: 'Hate or harassment',
  illegal: 'Something illegal',
  privacy: 'Private details, or people who didn’t agree to be shown',
  copyright: 'Someone else’s photo',
  spam: 'Spam or misleading',
  other: 'Something else',
};

type Sent = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Report on the tour page: flags the panorama on screen with a reason and an optional
 * note, for the operator's review. Anonymous; the mail link stays for longer reports.
 */
export function FlagDialog({
  open,
  onClose,
  tourId,
  slug,
  panoId,
}: {
  open: boolean;
  onClose: () => void;
  tourId: string;
  slug: string;
  panoId: string;
}) {
  const { apiBase, siteOrigin } = useConfig();
  const api = useMemo(() => createPublicApi({ baseUrl: apiBase }), [apiBase]);
  const titleId = useModalTitleId();
  const noteId = useId();
  const [reason, setReason] = useState<FlagReason | null>(null);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<Sent>('idle');

  // Fresh each time it opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setReason(null);
      setNote('');
      setSent('idle');
    }
  }

  const send = async () => {
    if (!reason) return;
    setSent('sending');
    try {
      const trimmed = note.trim();
      await api.flagPano(tourId, { panoId, reason, ...(trimmed ? { note: trimmed } : {}) });
      setSent('sent');
    } catch {
      setSent('error');
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={420} radius={18} labelledBy={titleId}>
      <div className="pn-confirm tour-flag">
        <h2 id={titleId} className="pn-confirm__title">
          Report this panorama
        </h2>
        {sent === 'sent' ? (
          <>
            <p className="pn-confirm__body">Thanks. We’ll take a look.</p>
            <div className="pn-confirm__actions">
              <Button variant="primary" onClick={onClose} data-autofocus>
                Done
              </Button>
            </div>
          </>
        ) : (
          <>
            <fieldset className="tour-flag__reasons">
              <legend className="pn-confirm__body">What’s wrong with it?</legend>
              {FLAG_REASONS.map((r) => (
                <label key={r} className="tour-flag__reason">
                  <input
                    type="radio"
                    name="flag-reason"
                    value={r}
                    checked={reason === r}
                    onChange={() => setReason(r)}
                  />
                  {FLAG_REASON_LABELS[r]}
                </label>
              ))}
            </fieldset>
            <label className="tour-flag__label" htmlFor={noteId}>
              Anything else? (optional)
            </label>
            <textarea
              id={noteId}
              className="tour-flag__note"
              rows={3}
              maxLength={MAX_FLAG_NOTE_LENGTH}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            {sent === 'error' && (
              <p className="pn-confirm__error" role="alert">
                Couldn’t send that. Try again.
              </p>
            )}
            <p className="tour-flag__mail">
              Need to say more? <a href={reportHref(siteOrigin, slug)}>Email us instead</a>.
            </p>
            <div className="pn-confirm__actions">
              <Button variant="ghost" onClick={onClose} disabled={sent === 'sending'}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void send()}
                disabled={!reason}
                busy={sent === 'sending'}
              >
                Send report
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
