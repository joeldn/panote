import './account.css';

import { ACCOUNT_DELETE_CONFIRMATION } from '@internal/contracts';
import { ConfirmModal } from '@internal/ui';
import { useId, useState } from 'react';

import { useAuthEnv } from '../auth-context.js';
import type { Session } from '../session.js';

export interface DeleteAccountModalProps {
  open: boolean;
  session: Session;
  onClose: () => void;
}

/**
 * The account menu's "Delete account": a typed confirmation, then the delete,
 * then sign-out. A `pending` result is still a success for the owner: the
 * account is already read-only and the daily sweep removes what's left.
 */
export function DeleteAccountModal({ open, session, onClose }: DeleteAccountModalProps) {
  const { origins, assign } = useAuthEnv();
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === ACCOUNT_DELETE_CONFIRMATION;

  const close = () => {
    setTyped('');
    onClose();
  };

  const confirm = async () => {
    try {
      await session.api.deleteAccount(typed.trim());
    } catch {
      throw new Error('Your account couldn’t be deleted. Try again in a moment.');
    }
    // The account is gone either way: a failed sign-out must not offer a retry.
    try {
      await session.signOut();
    } catch {
      assign(`${origins.website}/`);
    }
  };

  return (
    <ConfirmModal
      open={open}
      title="Delete your account?"
      body={
        <>
          <p className="delete-account__text">
            This removes every tour and panorama you’ve made, with their share links and view
            counts. It can’t be undone. Your sign-in record is removed within 30 days.
          </p>
          <label className="delete-account__label" htmlFor={inputId}>
            Type <strong>{ACCOUNT_DELETE_CONFIRMATION}</strong> to confirm
          </label>
          <input
            id={inputId}
            className="delete-account__input"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </>
      }
      confirmLabel="Delete account"
      confirmDisabled={!matches}
      onConfirm={confirm}
      onCancel={close}
    />
  );
}
