import './people.css';

import { MAX_MEMBERSHIPS, parseInviteToken, type InviteRefused } from '@internal/contracts';
import { Button, SignInModal } from '@internal/ui';
import { isAuthError, type ConnectionId } from '@internal/web-kit';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { useAdminApi } from '../admin-api.js';
import { useAuthEnv } from '../auth-context.js';

type State =
  | { status: 'accepting' }
  | { status: 'refused'; refusal: InviteRefused; tourId: string }
  | { status: 'broken' }
  | { status: 'error'; message: string };

/** What the person holding the link reads, and does, for each refusal. */
function refusalText(refusal: InviteRefused): string {
  switch (refusal.error) {
    case 'invite not found':
      return 'This invite isn’t valid any more. It may have been cancelled or replaced by a newer link. Ask the tour’s owner for a new one.';
    case 'invite expired':
      return 'This invite has expired. Ask the tour’s owner for a new one.';
    case 'no verified email':
      return refusal.email
        ? `This invite is for ${refusal.email}, and the account you’re signed in with has no verified email address. Sign in with that address instead.`
        : 'The account you’re signed in with has no verified email address, so the invite can’t be matched to it.';
    case 'wrong account':
      return refusal.email
        ? `This invite is for ${refusal.email}, but you’re signed in with another account. Sign in with that address to accept it.`
        : 'This invite is for another account. Sign in with the address it was sent to.';
    case 'own tour':
      return 'This is your own tour, so there’s nothing to accept.';
    case 'too many shared tours':
      return `You can edit up to ${MAX_MEMBERSHIPS} tours that other people own. Leave one before accepting this invite.`;
  }
}

/**
 * /app/invite#<token>: accepts an editor invite for the signed-in account, then opens the
 * tour. The token rides in the fragment, so it never reaches a server log or a Referer.
 */
export function InviteRoute() {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const api = useAdminApi();
  const { auth, origins } = useAuthEnv();
  const token = hash.replace(/^#/, '');
  const parsed = parseInviteToken(token);
  const [state, setState] = useState<State>(
    parsed ? { status: 'accepting' } : { status: 'broken' },
  );
  const [attempt, setAttempt] = useState(0);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    if (!parsed) return;
    let live = true;
    // Accepting twice is harmless: the server answers an existing editor the same way.
    api.acceptInvite(token).then(
      (res) => {
        if (!live) return;
        if (res.status === 'ok') {
          void navigate(`/t/${res.data.tourId}`, { replace: true });
        } else {
          setState({ status: 'refused', refusal: res.refusal, tourId: parsed.tourId });
        }
      },
      (e: unknown) => {
        if (!live) return;
        setState({
          status: 'error',
          message: isAuthError(e)
            ? 'Sign in again to accept this invite.'
            : 'Couldn’t accept the invite. Try again.',
        });
      },
    );
    return () => {
      live = false;
    };
    // `parsed` is derived from `token`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, token, navigate, attempt]);

  const refusal = state.status === 'refused' ? state.refusal : null;
  const switchTo =
    refusal && (refusal.error === 'wrong account' || refusal.error === 'no verified email')
      ? (refusal.email ?? null)
      : null;

  if (signingIn && switchTo) {
    return (
      <SignInModal
        open
        onClose={() => setSigningIn(false)}
        title="Sign in to accept the invite"
        subtitle={`Use the account for ${switchTo}. You’ll come back here to finish.`}
        options={auth.connections}
        onSignIn={(id) =>
          auth.signIn({
            connection: id as ConnectionId,
            returnTo: `/app/invite${hash}`,
            // Asks for an account even while this one is still signed in at Auth0.
            reauthenticate: true,
            loginHint: switchTo,
          })
        }
        termsHref={`${origins.website}/terms`}
        privacyHref={`${origins.website}/privacy`}
      />
    );
  }

  let body;
  if (state.status === 'accepting') {
    body = (
      <p className="ppl__status" role="status">
        Accepting the invite…
      </p>
    );
  } else if (state.status === 'broken') {
    body = (
      <p className="ppl__status" role="alert">
        This invite link is incomplete. Copy the whole link from the message it came in, or ask the
        tour’s owner to send it again.
      </p>
    );
  } else if (state.status === 'error') {
    body = (
      <>
        <p className="ppl__status" role="alert">
          {state.message}
        </p>
        <div className="ppl__actions">
          <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p className="ppl__status" role="alert">
          {refusalText(state.refusal)}
        </p>
        <div className="ppl__actions">
          {switchTo && <Button onClick={() => setSigningIn(true)}>Sign in as {switchTo}</Button>}
          {state.refusal.error === 'own tour' ? (
            <Link className="pn-btn pn-btn--primary" to={`/t/${state.tourId}`}>
              Open the tour
            </Link>
          ) : (
            <Link className="pn-btn pn-btn--ghost" to="/">
              Your tours
            </Link>
          )}
        </div>
      </>
    );
  }

  return (
    <main className="ppl-page">
      <h1 className="ppl-page__title">Tour invite</h1>
      {body}
    </main>
  );
}
