import './people.css';

import { INVITE_DAYS, type MembersOk, type MemberView } from '@internal/contracts';
import { Button, ConfirmModal, Modal, ModalHeader, useCopy, useModalTitleId } from '@internal/ui';
import { ApiError, isAuthError } from '@internal/web-kit';
import { useEffect, useState, type FormEvent } from 'react';
import { useHref, useNavigate, useParams, useSearchParams } from 'react-router';

import { useAdminApi } from '../admin-api.js';

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

type Confirming = { kind: 'remove'; member: MemberView } | { kind: 'leave'; member: MemberView };

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
    try {
      await api.removeMember(tourId, confirming.member.id);
    } catch (err) {
      throw new Error(
        isAuthError(err)
          ? 'Sign in again to change this list.'
          : 'Something went wrong. Try again.',
        { cause: err },
      );
    }
    const leaving = confirming.kind === 'leave';
    setConfirming(null);
    // Without access the editor under this modal has nothing to show.
    if (leaving) void navigate('/');
    else reload();
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
    const { role, ownerEmail, members, invites } = state.data;
    const owner = role === 'owner';
    body = (
      <>
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
                <span className="ppl__role">Editor</span>
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
        title={confirming?.kind === 'leave' ? 'Leave this tour?' : 'Remove this editor?'}
        body={
          confirming?.kind === 'leave'
            ? 'You won’t be able to open or edit it any more. The owner can invite you again.'
            : `${confirming?.member.email ?? ''} won’t be able to open or edit this tour any more. What they added stays in it.`
        }
        confirmLabel={confirming?.kind === 'leave' ? 'Leave' : 'Remove'}
        onConfirm={onConfirm}
        onCancel={() => setConfirming(null)}
      />
    </>
  );
}
