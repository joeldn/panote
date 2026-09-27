import { useState, type ReactNode } from 'react';

import { Button } from './Button.js';
import { Modal } from './Modal.js';
import { useModalTitleId } from './use-modal-title-id.js';

export interface ConfirmModalProps {
  open: boolean;
  title: ReactNode;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions use the accent-red button (default true). */
  danger?: boolean;
  /**
   * Runs on confirm. A returned promise keeps the modal busy until it settles;
   * a rejection shows its message and leaves the modal open.
   */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/** 392px destructive-action confirm (delete tour, delete point, remove pano). */
export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const titleId = useModalTitleId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on close during render (React's "adjust state on prop change").
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setBusy(false);
      setError(null);
    }
  }

  const confirm = async () => {
    setError(null);
    const result = onConfirm();
    if (!result) return;
    setBusy(true);
    try {
      await result;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onCancel}
      width={392}
      radius={18}
      labelledBy={titleId}
    >
      <div className="pn-confirm">
        <h2 id={titleId} className="pn-confirm__title">
          {title}
        </h2>
        <div className="pn-confirm__body">{body}</div>
        {error && (
          <p className="pn-confirm__error" role="alert">
            {error}
          </p>
        )}
        <div className="pn-confirm__actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy} data-autofocus>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => void confirm()}
            busy={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
