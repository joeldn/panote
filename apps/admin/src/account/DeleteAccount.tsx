import './account.css';

import { ACCOUNT_DELETE_CONFIRMATION } from '@internal/contracts';
import { ConfirmModal, SignInModal } from '@internal/ui';
import { CONTACT_EMAIL, ReauthRequiredError, type ConnectionId } from '@internal/web-kit';
import { useId, useRef, useState } from 'react';
import { useLocation } from 'react-router';

import { useAuthEnv } from '../auth-context.js';
import { cancelBeforeSignIn, runBeforeSignIn } from '../before-sign-in.js';
import type { Session } from '../session.js';

/** The query param that brings the owner back to this dialog after signing in again. */
export const DELETE_ACCOUNT_PARAM = 'delete-account';
export const DELETE_ACCOUNT_RESUME = 'reauthenticated';

export interface DeleteAccountModalProps {
  open: boolean;
  session: Session;
  onClose: () => void;
  /** Back from the sign-in this dialog asked for: a second refusal isn't a stale sign-in. */
  reauthenticated?: boolean;
}

/** The current admin page (`/app/...`) with the resume param added, for the sign-in's returnTo. */
function useResumePath(): string {
  const { pathname, search, hash } = useLocation();
  const params = new URLSearchParams(search);
  params.set(DELETE_ACCOUNT_PARAM, DELETE_ACCOUNT_RESUME);
  return `/app${pathname === '/' ? '/' : pathname}?${params.toString()}${hash}`;
}

/**
 * The account menu's "Delete account": a typed confirmation, then the delete,
 * then sign-out. A `pending` result is still a success for the owner: the
 * account is already read-only and the daily sweep removes what's left.
 *
 * The server wants a recent sign-in. When the last one is too old it answers
 * `ReauthRequiredError`: the dialog asks the owner to sign in again (Auth0 with
 * `prompt=login`), which brings them back here to type the phrase once more.
 */
export function DeleteAccountModal({
  open,
  session,
  onClose,
  reauthenticated = false,
}: DeleteAccountModalProps) {
  const { auth, origins, assign } = useAuthEnv();
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const warnedRef = useRef(false);
  const resumePath = useResumePath();
  const matches = typed.trim() === ACCOUNT_DELETE_CONFIRMATION;

  const close = () => {
    setTyped('');
    setSigningIn(false);
    onClose();
  };

  const confirm = async () => {
    try {
      await session.api.deleteAccount(typed.trim());
    } catch (e) {
      if (e instanceof ReauthRequiredError) {
        // Just signed in and still refused: the tenant isn't sending the sign-in
        // time. Signing in again wouldn't help, so say so instead of looping.
        if (reauthenticated) {
          throw new Error(
            `We couldn’t confirm your sign-in, so your account wasn’t deleted. Please contact ${CONTACT_EMAIL}.`,
            { cause: e },
          );
        }
        setSigningIn(true);
        return;
      }
      throw new Error('Your account couldn’t be deleted. Try again in a moment.', { cause: e });
    }
    // The account is gone either way: a failed sign-out must not offer a retry.
    try {
      await session.signOut();
    } catch {
      assign(`${origins.website}/`);
    }
  };

  const signInAgain = async (id: string) => {
    // As the session-ended prompt does: a screen that can't park its unsaved work
    // warns on the first attempt, and a second click goes ahead anyway.
    const refusal = runBeforeSignIn({ force: warnedRef.current });
    if (refusal && !warnedRef.current) {
      warnedRef.current = true;
      throw new Error(`${refusal} Choose a sign-in option again to continue anyway.`);
    }
    try {
      await auth.signIn({
        connection: id as ConnectionId,
        returnTo: resumePath,
        reauthenticate: true,
      });
    } catch (e) {
      cancelBeforeSignIn();
      throw e;
    }
  };

  if (open && signingIn) {
    return (
      <SignInModal
        open
        onClose={close}
        title="Sign in again to delete your account"
        subtitle="To keep your account safe, confirm it’s you. You’ll come back here to finish."
        options={auth.connections}
        onSignIn={signInAgain}
        termsHref={`${origins.website}/terms`}
        privacyHref={`${origins.website}/privacy`}
      />
    );
  }

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
