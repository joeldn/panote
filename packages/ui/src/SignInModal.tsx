import { useState, type ReactNode } from 'react';

import { LogoMark } from './Logo.js';
import { Modal } from './Modal.js';
import { useModalTitleId } from './use-modal-title-id.js';

export interface SignInOption {
  id: string;
  label: string;
  /** Font Awesome classes, e.g. `fa-brands fa-google`. */
  icon: string;
}

export interface SignInModalProps {
  open: boolean;
  onClose: () => void;
  /** Enabled social connections; an empty list shows `unavailable` instead. */
  options: readonly SignInOption[];
  /** Starts the redirect; a rejection shows its message and re-enables the buttons. */
  onSignIn: (id: string) => Promise<void>;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Shown instead of the buttons when sign-in can't work here (no tenant configured). */
  unavailable?: ReactNode;
  termsHref?: string;
  privacyHref?: string;
}

/** 392px social sign-in card (design README "Sign-in modal"): SSO buttons only. */
export function SignInModal({
  open,
  onClose,
  options,
  onSignIn,
  title = 'Sign in to panote',
  subtitle = (
    <>
      Use an account you already have —<br />
      no new password to remember.
    </>
  ),
  unavailable = 'Sign-in isn’t available here yet.',
  termsHref = '/terms',
  privacyHref = '/privacy',
}: SignInModalProps) {
  const titleId = useModalTitleId();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setPending(null);
      setError(null);
    }
  }

  const start = async (id: string) => {
    setError(null);
    setPending(id);
    try {
      await onSignIn(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed. Try again.');
      setPending(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={392} labelledBy={titleId}>
      <div className="pn-signin">
        <button
          type="button"
          className="pn-modal__close pn-signin__close"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>
        <div className="pn-signin__head">
          <LogoMark size={38} />
          <h2 id={titleId} className="pn-signin__title">
            {title}
          </h2>
          <p className="pn-signin__sub">{subtitle}</p>
        </div>
        {options.length === 0 ? (
          <p className="pn-signin__unavailable" role="status">
            {unavailable}
          </p>
        ) : (
          <div className="pn-signin__options">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                className="pn-signin__option"
                disabled={pending !== null}
                aria-busy={pending === o.id || undefined}
                onClick={() => void start(o.id)}
              >
                <span className="pn-signin__glyph" aria-hidden="true">
                  {pending === o.id ? (
                    <span className="pn-btn__spinner" />
                  ) : (
                    <i className={o.icon} />
                  )}
                </span>
                Continue with {o.label}
              </button>
            ))}
          </div>
        )}
        {error && (
          <p className="pn-signin__error" role="alert">
            {error}
          </p>
        )}
        <p className="pn-signin__secured">
          <i className="fa-solid fa-lock" aria-hidden="true" />
          Secured by Auth0
        </p>
        <p className="pn-signin__legal">
          By continuing you agree to panote’s <a href={termsHref}>Terms</a> &amp;{' '}
          <a href={privacyHref}>Privacy Policy</a>.
        </p>
      </div>
    </Modal>
  );
}
