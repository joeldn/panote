import './account.css';

import { ACCOUNT_DELETE_CONFIRMATION } from '@internal/contracts';
import { ConfirmModal, SignInModal } from '@internal/ui';
import { CONTACT_EMAIL, ReauthRequiredError, type ConnectionId } from '@internal/web-kit';
import { useId, useRef, useState } from 'react';
import { useLocation } from 'react-router';

import { useAuthEnv } from '../auth-context.js';
import { cancelBeforeSignIn, runBeforeSignIn } from '../before-sign-in.js';
import type { Session } from '../session.js';
import {
  DELETE_ACCOUNT_PARAM,
  DELETE_ACCOUNT_RESUME,
  forgetDeletingSub,
  rememberDeletingSub,
} from './delete-account-resume.js';

export interface DeleteAccountModalProps {
  open: boolean;
  session: Session;
  onClose: () => void;
  /** Back from the sign-in this dialog asked for: a second refusal isn't a stale sign-in. */
  reauthenticated?: boolean;
  /** With `reauthenticated`: the sub that asked to sign in again (null when unknown). */
  expectedSub?: string | null;
}

/** The current admin page (`/app/...`) with the resume param added, for the sign-in's returnTo. */
function useResumePath(): string {
  const { pathname, search, hash } = useLocation();
  const params = new URLSearchParams(search);
  params.set(DELETE_ACCOUNT_PARAM, DELETE_ACCOUNT_RESUME);
  return `/app${pathname === '/' ? '/' : pathname}?${params.toString()}${hash}`;
}

/**
 * The account window's "Delete account": a typed confirmation, then the delete,
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
  expectedSub = null,
}: DeleteAccountModalProps) {
  const { auth, origins, assign } = useAuthEnv();
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const warnedRef = useRef(false);
  const resumePath = useResumePath();
  const matches = typed.trim() === ACCOUNT_DELETE_CONFIRMATION;
  // Back from signing in again, but not as the account that asked: deleting now would
  // delete this other account, so the dialog refuses.
  const wrongAccount =
    reauthenticated && (!expectedSub || !session.user.sub || expectedSub !== session.user.sub);
  const wrongAccountMessage = expectedSub
    ? 'You signed in with a different account from the one you were deleting, so nothing was deleted. To delete that account, sign out and sign in with it, then try again.'
    : 'We couldn’t tell which account you were deleting, so nothing was deleted. Open Account from the menu and choose Delete account to start again.';

  const close = () => {
    setTyped('');
    setSigningIn(false);
    onClose();
  };

  const confirm = async () => {
    if (wrongAccount) throw new Error(wrongAccountMessage);
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
    rememberDeletingSub(session.user.sub);
    try {
      await auth.signIn({
        connection: id as ConnectionId,
        returnTo: resumePath,
        reauthenticate: true,
        // Steers Auth0 to the same account where the connection can use it (the email code).
        ...(session.user.email && { loginHint: session.user.email }),
      });
    } catch (e) {
      cancelBeforeSignIn();
      forgetDeletingSub();
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
          {wrongAccount && (
            <p className="delete-account__text" role="alert">
              {wrongAccountMessage}
            </p>
          )}
        </>
      }
      confirmLabel="Delete account"
      confirmDisabled={!matches || wrongAccount}
      onConfirm={confirm}
      onCancel={close}
    />
  );
}
