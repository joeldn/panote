import './people.css';

import {
  INVITE_DAYS,
  TOUR_TRANSFERRING_ERROR,
  TRANSFER_OFFER_DAYS,
  type MembersOk,
  type MemberView,
  type TransferRefused,
} from '@internal/contracts';
import {
  Button,
  ConfirmModal,
  Modal,
  ModalHeader,
  SignInModal,
  useCopy,
  useModalTitleId,
} from '@internal/ui';
import { ApiError, isAuthError, ReauthRequiredError, type ConnectionId } from '@internal/web-kit';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useHref, useNavigate, useParams, useSearchParams } from 'react-router';

import { useAdminApi } from '../admin-api.js';
import { useAuthEnv } from '../auth-context.js';
import { cancelBeforeSignIn, runBeforeSignIn } from '../before-sign-in.js';
import { useSession } from '../session.js';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: MembersOk };

/** The invite just made: its link exists only here, the server keeps a hash. */
interface Created {
  email: string;
  link: string;
  expiresAt: string;
}

type Confirming = { kind: 'remove' | 'leave' | 'offer'; member: MemberView };

/** User-facing copy for a refused take-over (services/admin-api transfer.ts). */
function transferMessage(refusal: TransferRefused): string {
  switch (refusal.error) {
    case 'no offer':
      return 'The owner has withdrawn this offer.';
    case 'offer expired':
      return 'This offer has expired. Ask the owner to make it again.';
    case 'tour limit reached':
      return 'You have as many tours as an account can hold. Delete one first.';
    case 'pano limit reached':
      return 'This tour’s panos would take you past the number of panos an account can hold. Delete some first.';
    case 'storage limit reached':
      return 'This tour’s panos would take you past your storage limit. Delete some panos first.';
  }
}

const CONFIRM_COPY = {
  remove: { title: 'Remove this editor?', label: 'Remove' },
  leave: { title: 'Leave this tour?', label: 'Leave' },
  offer: { title: 'Make them the owner?', label: 'Offer the tour' },
} as const;

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const errorOf = (e: unknown): string | null =>
  e instanceof ApiError && typeof e.body === 'object' && e.body !== null && 'error' in e.body
    ? String((e.body as { error: unknown }).error)
    : null;

/** User-facing copy for a refused invite (services/admin-api members.ts createInvite). */
function inviteMessage(e: unknown): string {
  if (isAuthError(e)) return 'Sign in again to invite people.';
  const error = errorOf(e);
  if (error === 'own email') return 'That’s your own address. Invite someone else.';
  if (error === 'already an editor') return 'They can already edit this tour.';
  if (error === 'tour full') {
    return 'This tour has as many editors and open invites as it can take. Remove one first.';
  }
  if (e instanceof ApiError && e.status === 400) return 'Enter a valid email address.';
  if (e instanceof ApiError && e.status === 429)
    return 'Too many requests. Wait a minute and try again.';
  return 'Couldn’t create the invite. Try again.';
}

/** A change to the list that failed: a remove, a leave, an offer and its answers. */
function changeMessage(e: unknown): string {
  if (isAuthError(e)) return 'Sign in again to change this list.';
  if (errorOf(e) === TOUR_TRANSFERRING_ERROR) {
    return 'This tour is changing owner. Try again in a minute.';
  }
  return 'Something went wrong. Try again.';
}

const confirmBody = (confirming: Confirming | null): string => {
  const email = confirming?.member.email ?? '';
  switch (confirming?.kind) {
    case 'leave':
      return 'You won’t be able to open or edit it any more. The owner can invite you again.';
    case 'offer':
      return `If ${email} accepts, the tour, its share link and its panos move to their account, and you stay on as an editor. Panos your other tours also use are copied for them. The offer lasts ${TRANSFER_OFFER_DAYS} days.`;
    default:
      return `${email} won’t be able to open or edit this tour any more. What they added stays in it.`;
  }
};

const loadError = (e: unknown): string =>
  isAuthError(e)
    ? 'Sign in again to see who can edit this tour.'
    : 'Couldn’t load this list. Try again.';

/** Who can edit a tour, over the editor at /app/t/:tourId/people. */
export function PeopleRoute() {
  const { tourId = '' } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const api = useAdminApi();
  const session = useSession();
  const { auth, origins } = useAuthEnv();
  const titleId = useModalTitleId();
  const invitePath = useHref('/invite');
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [email, setEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [taking, setTaking] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);
  const warnedRef = useRef(false);
  const [copied, copy] = useCopy();

  useEffect(() => {
    let live = true;
    api.getMembers(tourId).then(
      (data) => live && setState({ status: 'ready', data }),
      (e: unknown) => {
        if (!live) return;
        const message =
          e instanceof ApiError && e.status === 404 ? 'This tour no longer exists.' : loadError(e);
        setState({ status: 'error', message });
      },
    );
    return () => {
      live = false;
    };
  }, [api, tourId, attempt]);

  const query = search.toString();
  const close = () => void navigate({ pathname: `/t/${tourId}`, search: query ? `?${query}` : '' });
  const reload = () => setAttempt((n) => n + 1);

  const onInvite = async (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setInviting(true);
    setInviteError(null);
    try {
      const res = await api.createInvite(tourId, address);
      setCreated({
        email: res.invite.email,
        link: `${window.location.origin}${invitePath}#${res.token}`,
        expiresAt: res.invite.expiresAt,
      });
      setEmail('');
      reload();
    } catch (err) {
      setInviteError(inviteMessage(err));
    } finally {
      setInviting(false);
    }
  };

  const onRevoke = async (inviteId: string) => {
    setRowError(null);
    try {
      await api.revokeInvite(tourId, inviteId);
      if (created && state.status === 'ready') {
        const gone = state.data.invites.find((i) => i.id === inviteId);
        if (gone?.email === created.email) setCreated(null);
      }
      reload();
    } catch (err) {
      setRowError(
        isAuthError(err) ? 'Sign in again to change this list.' : 'Couldn’t cancel the invite.',
      );
    }
  };

  const onConfirm = async () => {
    if (!confirming) return;
    if (confirming.kind === 'offer') {
      try {
        await api.offerTransfer(tourId, confirming.member.id);
      } catch (err) {
        if (err instanceof ReauthRequiredError) {
          setConfirming(null);
          setSigningIn(true);
          return;
        }
        throw new Error(changeMessage(err), { cause: err });
      }
      setConfirming(null);
      reload();
      return;
    }
    try {
      await api.removeMember(tourId, confirming.member.id);
    } catch (err) {
      throw new Error(changeMessage(err), { cause: err });
    }
    const leaving = confirming.kind === 'leave';
    setConfirming(null);
    // Without access the editor under this modal has nothing to show.
    if (leaving) void navigate('/');
    else reload();
  };

  // Offering a tour wants a recent sign-in (as account delete does); back here afterwards.
  const signInAgain = async (id: string) => {
    const refusal = runBeforeSignIn({ force: warnedRef.current });
    if (refusal && !warnedRef.current) {
      warnedRef.current = true;
      throw new Error(`${refusal} Choose a sign-in option again to continue anyway.`);
    }
    try {
      await auth.signIn({
        connection: id as ConnectionId,
        returnTo: `/app/t/${tourId}/people${query ? `?${query}` : ''}`,
        reauthenticate: true,
        ...(session.user.email && { loginHint: session.user.email }),
      });
    } catch (e) {
      cancelBeforeSignIn();
      throw e;
    }
  };

  const onWithdraw = async () => {
    setOfferError(null);
    try {
      await api.cancelTransfer(tourId);
      reload();
    } catch (err) {
      setOfferError(changeMessage(err));
    }
  };

  const onTake = async () => {
    setOfferError(null);
    setTaking(true);
    try {
      const res = await api.acceptTransfer(tourId);
      if (res.status === 'refused') {
        setOfferError(transferMessage(res.refusal));
        reload();
        return;
      }
      // The tour is theirs now: their dashboard lists it with their own tours.
      void navigate('/');
    } catch (err) {
      setOfferError(changeMessage(err));
    } finally {
      setTaking(false);
    }
  };

  let body;
  if (state.status === 'loading') {
    body = (
      <p className="ppl__status" role="status">
        Loading…
      </p>
    );
  } else if (state.status === 'error') {
    body = (
      <p className="ppl__status" role="alert">
        {state.message}
      </p>
    );
  } else {
    const { role, ownerEmail, members, invites, transfer } = state.data;
    const owner = role === 'owner';
    const offeredTo = transfer && members.find((m) => m.id === transfer.memberId);
    body = (
      <>
        {offeredTo?.you && (
          <div className="ppl__created" role="status">
            <p className="ppl__created-text">
              {ownerEmail ?? 'The owner'} wants to make you this tour’s owner. Its panos would move
              to your account and count toward your limits, and they would stay on as an editor.
            </p>
            <div className="ppl__actions">
              <Button busy={taking} onClick={() => void onTake()}>
                Become the owner
              </Button>
              <Button variant="ghost" disabled={taking} onClick={() => void onWithdraw()}>
                Decline
              </Button>
            </div>
          </div>
        )}
        {offerError && (
          <p className="ppl__error" role="alert">
            {offerError}
          </p>
        )}
        {owner && (
          <form className="ppl__invite" onSubmit={(e) => void onInvite(e)}>
            <label className="ppl__label" htmlFor="ppl-email">
              Invite an editor
            </label>
            <div className="ppl__invite-row">
              <input
                id="ppl-email"
                className="ppl__input"
                type="email"
                autoComplete="off"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button type="submit" busy={inviting} disabled={!email.trim()}>
                Create link
              </Button>
            </div>
            {inviteError && (
              <p className="ppl__error" role="alert">
                {inviteError}
              </p>
            )}
            <p className="ppl__hint">
              Editors can change and save this tour, add panos to it and see its insights. Sharing
              settings stay yours.
            </p>
          </form>
        )}
        {created && (
          <div className="ppl__created" role="status">
            <p className="ppl__created-text">
              Send this link to <strong>{created.email}</strong> yourself. It works once, for that
              address, until {formatDate(created.expiresAt)}.
            </p>
            <div className="ppl__invite-row">
              <input
                className="ppl__input"
                readOnly
                aria-label="Invite link"
                value={created.link}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button onClick={() => void copy(created.link)}>
                {copied === 'copied' ? 'Copied ✓' : copied === 'failed' ? 'Copy failed' : 'Copy'}
              </Button>
            </div>
          </div>
        )}
        <section className="ppl__section" aria-labelledby="ppl-people">
          <h3 id="ppl-people" className="ppl__label">
            Who can edit
          </h3>
          <ul className="ppl__list">
            <li className="ppl__row">
              <span className="ppl__who">
                {ownerEmail ?? (owner ? 'You' : 'The owner')}
                {owner && ownerEmail && <span className="ppl__you"> (you)</span>}
              </span>
              <span className="ppl__role">Owner</span>
            </li>
            {members.map((m) => (
              <li key={m.id} className="ppl__row">
                <span className="ppl__who">
                  {m.email}
                  {m.you && <span className="ppl__you"> (you)</span>}
                </span>
                <span className="ppl__role">
                  {offeredTo?.id === m.id
                    ? `Offered the tour until ${formatDate(transfer!.expiresAt)}`
                    : 'Editor'}
                </span>
                {owner && offeredTo?.id === m.id && (
                  <button
                    type="button"
                    className="ppl__action"
                    aria-label={`Withdraw the offer to ${m.email}`}
                    onClick={() => void onWithdraw()}
                  >
                    Withdraw
                  </button>
                )}
                {owner && offeredTo?.id !== m.id && (
                  <button
                    type="button"
                    className="ppl__action"
                    aria-label={`Make ${m.email} the owner`}
                    onClick={() => setConfirming({ kind: 'offer', member: m })}
                  >
                    Make owner
                  </button>
                )}
                {owner && (
                  <button
                    type="button"
                    className="ppl__action"
                    aria-label={`Remove ${m.email}`}
                    onClick={() => setConfirming({ kind: 'remove', member: m })}
                  >
                    Remove
                  </button>
                )}
                {m.you && (
                  <button
                    type="button"
                    className="ppl__action"
                    onClick={() => setConfirming({ kind: 'leave', member: m })}
                  >
                    Leave
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
        {owner && invites.length > 0 && (
          <section className="ppl__section" aria-labelledby="ppl-invites">
            <h3 id="ppl-invites" className="ppl__label">
              Invited
            </h3>
            <ul className="ppl__list">
              {invites.map((i) => (
                <li key={i.id} className="ppl__row">
                  <span className="ppl__who">{i.email}</span>
                  <span className="ppl__role">Until {formatDate(i.expiresAt)}</span>
                  <button
                    type="button"
                    className="ppl__action"
                    aria-label={`Cancel the invite for ${i.email}`}
                    onClick={() => void onRevoke(i.id)}
                  >
                    Cancel
                  </button>
                </li>
              ))}
            </ul>
            <p className="ppl__hint">
              An invite link works for {INVITE_DAYS} days. Lost one? Invite the same address again
              for a fresh link.
            </p>
          </section>
        )}
        {rowError && (
          <p className="ppl__error" role="alert">
            {rowError}
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <Modal open onClose={close} width={520} labelledBy={titleId}>
        <ModalHeader id={titleId} title="People" onClose={close} />
        <div className="ppl">{body}</div>
      </Modal>
      <ConfirmModal
        open={confirming !== null}
        title={CONFIRM_COPY[confirming?.kind ?? 'remove'].title}
        body={confirmBody(confirming)}
        confirmLabel={CONFIRM_COPY[confirming?.kind ?? 'remove'].label}
        onConfirm={onConfirm}
        onCancel={() => setConfirming(null)}
      />
      <SignInModal
        open={signingIn}
        onClose={() => setSigningIn(false)}
        title="Sign in again to offer this tour"
        subtitle="Giving a tour away can’t be undone by you, so confirm it’s you. You’ll come back here; offer it again to finish."
        options={auth.connections}
        onSignIn={signInAgain}
        termsHref={`${origins.website}/terms`}
        privacyHref={`${origins.website}/privacy`}
      />
    </>
  );
}
