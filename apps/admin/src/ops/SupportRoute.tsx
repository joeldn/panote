import type { SupportTour, SupportUserView } from '@internal/contracts';
import { Button, ConfirmModal, SignInModal } from '@internal/ui';
import { ReauthRequiredError, type ConnectionId, type SupportAction } from '@internal/web-kit';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useLocation, useSearchParams } from 'react-router';

import { useAuthEnv } from '../auth-context.js';
import { formatBytes } from '../dashboard/format.js';
import { useSession } from '../session.js';

type Load = { status: 'idle' | 'loading' | 'error' } | { status: 'ready'; user: SupportUserView };

const day = (iso: string): string => iso.slice(0, 10);

const ofMax = (used: number, max: number | null, format: (n: number) => string = String) =>
  max === null ? format(used) : `${format(used)} of ${format(max)}`;

/**
 * /app/ops/users: find the account a support message is about (its account ID, which the
 * Contact support email carries, or a tour's share link or slug), see everything it holds,
 * and make the changes the operator scripts make. Every change needs a recent sign-in.
 * `?sub=` names the account, so a page can be bookmarked or reloaded after signing in.
 */
export function SupportRoute() {
  const { api } = useSession();
  const { auth, origins } = useAuthEnv();
  const { pathname, search } = useLocation();
  const [params, setParams] = useSearchParams();
  const sub = params.get('sub');
  const queryId = useId();
  const [query, setQuery] = useState('');
  const [lookupFailed, setLookupFailed] = useState<'not-found' | 'error' | null>(null);
  // A change's error, for the account it was made on: moving to another one drops it.
  const [failed, setFailed] = useState<{ sub: string; message: string } | null>(null);
  const actionError = failed && failed.sub === sub ? failed.message : null;
  // The account on screen now, for a change that answers after the page moved on.
  const current = useRef(sub);
  useEffect(() => {
    current.current = sub;
  }, [sub]);
  const [signingIn, setSigningIn] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [closing, setClosing] = useState(false);
  const [unpublishing, setUnpublishing] = useState<string | null>(null);

  // What came back, and for which account: a different `sub` reads as still loading.
  const [loaded, setLoaded] = useState<{ sub: string; load: Load } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!sub) return;
    let live = true;
    api.supportUser(sub).then(
      (user) => live && setLoaded({ sub, load: { status: 'ready', user } }),
      () => live && setLoaded({ sub, load: { status: 'error' } }),
    );
    return () => {
      live = false;
    };
  }, [api, sub, attempt]);
  const load: Load = !sub
    ? { status: 'idle' }
    : loaded?.sub === sub
      ? loaded.load
      : { status: 'loading' };
  const retry = () => {
    setLoaded(null);
    setAttempt((n) => n + 1);
  };

  const find = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLookupFailed(null);
    let found;
    try {
      found = await api.supportLookup(q);
    } catch {
      setLookupFailed('error');
      return;
    }
    if (!found) {
      setLookupFailed('not-found');
      return;
    }
    setParams({ sub: found.sub });
  };

  /** One change; the answer is the account as it is now. */
  const act = async (action: SupportAction, body?: unknown): Promise<void> => {
    if (!sub) return;
    setFailed(null);
    try {
      const user = await api.supportAction(sub, action, body);
      // Moved to another account meanwhile: this answer is not what the page shows now.
      if (current.current === sub) setLoaded({ sub, load: { status: 'ready', user } });
    } catch (e) {
      if (e instanceof ReauthRequiredError) {
        setSigningIn(true);
        return;
      }
      setFailed({ sub, message: e instanceof Error ? e.message : 'That didn’t work. Try again.' });
      throw e;
    }
  };
  const tryAct = (action: SupportAction, body?: unknown) => void act(action, body).catch(() => {});

  return (
    <div className="support">
      <form className="support__find" onSubmit={(e) => void find(e)}>
        <label htmlFor={queryId} className="dash__kicker">
          Find an account
        </label>
        <div className="support__find-row">
          <input
            id={queryId}
            className="support__input"
            type="search"
            placeholder="Account ID, tour link or slug"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button type="submit" variant="primary">
            Find
          </Button>
        </div>
        {lookupFailed === 'not-found' && (
          <p className="support__note" role="status">
            Nothing found. A tour from before owner records needs the takedown script.
          </p>
        )}
        {lookupFailed === 'error' && (
          <p className="support__note" role="alert">
            Couldn’t search just now. Try again.
          </p>
        )}
      </form>

      {load.status === 'loading' && (
        <p className="app-status" role="status">
          Loading…
        </p>
      )}
      {load.status === 'error' && (
        <div className="dash__banner dash__banner--warn" role="alert">
          <span>Couldn’t load that account.</span>
          <Button size="sm" variant="ghost" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
      {actionError && (
        <div className="dash__banner dash__banner--warn" role="alert">
          <span>{actionError}</span>
        </div>
      )}
      {load.status === 'ready' && (
        <UserView
          user={load.user}
          website={origins.website}
          onDisable={() => setDisabling(true)}
          onEnable={() => tryAct('enable')}
          onClose={() => setClosing(true)}
          onTour={(tourId, action) =>
            action === 'unpublish' ? setUnpublishing(tourId) : tryAct({ tour: tourId }, { action })
          }
          onRestore={(date, panoId) => tryAct('restore', { date, panoId })}
        />
      )}

      {sub && (
        <>
          <TypedConfirm
            open={disabling}
            title="Disable this account?"
            text="The owner can still sign in and see their tours, but can’t upload or change anything. Nothing is taken down."
            label="Reason (for the case log)"
            matches={(v) => v.trim().length > 0}
            confirmLabel="Disable"
            onConfirm={(reason) => act('disable', { reason: reason.trim() })}
            onCancel={() => setDisabling(false)}
          />
          <TypedConfirm
            open={closing}
            title="Close this account?"
            text="Marks it for deletion, as the owner’s own Delete account does. The daily sweep deletes every tour and panorama. It can’t be undone."
            label={`Type the account ID (${sub}) to confirm`}
            matches={(v) => v.trim() === sub}
            confirmLabel="Close account"
            onConfirm={(typed) => act('close', { confirm: typed.trim() })}
            onCancel={() => setClosing(false)}
          />
        </>
      )}
      <ConfirmModal
        open={unpublishing !== null}
        title="Unpublish this tour?"
        body={
          <p className="support__note">
            Its share link stops working and comes off Explore. The tour and its panos stay. Its
            link is held for 30 days, so not even the owner can publish at it again until then.
          </p>
        }
        confirmLabel="Unpublish"
        onConfirm={async () => {
          if (unpublishing) await act({ tour: unpublishing }, { action: 'unpublish' });
          setUnpublishing(null);
        }}
        onCancel={() => setUnpublishing(null)}
      />
      <SignInModal
        open={signingIn}
        onClose={() => setSigningIn(false)}
        title="Sign in again to make changes"
        subtitle="Changes to someone’s account need a recent sign-in. You’ll come back to this page; then make the change again."
        options={auth.connections}
        onSignIn={(id) =>
          auth.signIn({
            connection: id as ConnectionId,
            returnTo: `/app${pathname}${search}`,
            reauthenticate: true,
          })
        }
        termsHref={`${origins.website}/terms`}
        privacyHref={`${origins.website}/privacy`}
      />
    </div>
  );
}

function TypedConfirm({
  open,
  title,
  text,
  label,
  matches,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  text: string;
  label: string;
  matches: (typed: string) => boolean;
  confirmLabel: string;
  onConfirm: (typed: string) => Promise<void>;
  onCancel: () => void;
}) {
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const cancel = () => {
    setTyped('');
    onCancel();
  };
  return (
    <ConfirmModal
      open={open}
      title={title}
      body={
        <>
          <p className="support__note">{text}</p>
          <label className="support__label" htmlFor={inputId}>
            {label}
          </label>
          <input
            id={inputId}
            className="support__input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </>
      }
      confirmLabel={confirmLabel}
      confirmDisabled={!matches(typed)}
      onConfirm={async () => {
        await onConfirm(typed);
        cancel();
      }}
      onCancel={cancel}
    />
  );
}

function UserView({
  user,
  website,
  onDisable,
  onEnable,
  onClose,
  onTour,
  onRestore,
}: {
  user: SupportUserView;
  website: string;
  onDisable: () => void;
  onEnable: () => void;
  onClose: () => void;
  onTour: (tourId: string, action: 'unpublish' | 'hide' | 'unhide') => void;
  onRestore: (date: string, panoId: string) => void;
}) {
  const { usage, limits } = user;
  // Nothing at all under this ID: a mistyped one, or someone who never uploaded or saved.
  const empty =
    !user.since &&
    !user.disabled &&
    !user.deletion &&
    usage.panos === 0 &&
    usage.uploadsToday === 0 &&
    user.tours.length === 0 &&
    user.editsTours.length === 0 &&
    user.trash.length === 0;
  return (
    <>
      {empty && (
        <p className="dash__banner" role="status">
          Panote holds nothing for this account ID. Check it was copied whole.
        </p>
      )}
      <section className="support__section" aria-labelledby="support-account">
        <h2 id="support-account" className="dash__kicker">
          Account
        </h2>
        <dl className="support__facts">
          <dt>Account ID</dt>
          <dd className="support__id">{user.sub}</dd>
          <dt>Since</dt>
          <dd>{user.since ? day(user.since) : 'Never published'}</dd>
          <dt>Status</dt>
          <dd>
            {user.deletion
              ? user.deletion.completedAt
                ? `Deleted on ${day(user.deletion.completedAt)}`
                : `Being deleted (asked ${day(user.deletion.requestedAt)})`
              : user.disabled
                ? `Disabled since ${day(user.disabled.disabledAt)}${user.disabled.reason ? `: ${user.disabled.reason}` : ''}`
                : 'Active'}
          </dd>
          <dt>Panos</dt>
          <dd>{ofMax(usage.panos, limits.maxPanos)}</dd>
          <dt>Storage</dt>
          <dd>{ofMax(usage.bytes, limits.maxBytes, formatBytes)}</dd>
          <dt>Uploads in the past 24 hours</dt>
          <dd>{usage.uploadsToday}</dd>
          <dt>Tours</dt>
          <dd>{ofMax(usage.tours, limits.maxTours)}</dd>
          {user.editsTours.length > 0 && (
            <>
              <dt>Edits for others</dt>
              <dd>{user.editsTours.length} tour(s)</dd>
            </>
          )}
        </dl>
        <div className="support__actions">
          {user.disabled ? (
            <Button variant="ghost" onClick={onEnable}>
              Enable account
            </Button>
          ) : (
            <Button variant="ghost" onClick={onDisable}>
              Disable account
            </Button>
          )}
          {!user.deletion && !empty && (
            <Button variant="danger" onClick={onClose}>
              Close account
            </Button>
          )}
        </div>
      </section>

      <section className="support__section" aria-labelledby="support-tours">
        <h2 id="support-tours" className="dash__kicker">
          Tours
        </h2>
        {user.tours.length === 0 ? (
          <p className="support__note">No tours.</p>
        ) : (
          <ul className="support__list">
            {user.tours.map((t) => (
              <TourRow key={t.tourId} tour={t} website={website} onTour={onTour} />
            ))}
          </ul>
        )}
      </section>

      <section className="support__section" aria-labelledby="support-trash">
        <h2 id="support-trash" className="dash__kicker">
          Deleted panos
        </h2>
        {user.trash.length === 0 ? (
          <p className="support__note">Nothing in the trash.</p>
        ) : (
          <ul className="support__list">
            {user.trash.map((item) => (
              <li key={`${item.date}/${item.panoId}`} className="support__row">
                <span className="support__row-main">
                  <span className="support__id">{item.panoId}</span>
                  <span className="support__meta">
                    Deleted {item.date} · {formatBytes(item.bytes)}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => onRestore(item.date, item.panoId)}>
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function TourRow({
  tour,
  website,
  onTour,
}: {
  tour: SupportTour;
  website: string;
  onTour: (tourId: string, action: 'unpublish' | 'hide' | 'unhide') => void;
}) {
  const facts = [
    `${tour.sceneCount} scene(s)`,
    tour.publish ? (tour.publish.visibility === 'public' ? 'Public' : 'Unlisted') : 'Not published',
    tour.hiddenFromExplore && 'Hidden from Explore',
    tour.editors > 0 && `${tour.editors} editor(s)`,
    tour.transferring && 'Changing owner',
    `Changed ${day(tour.updatedAt)}`,
  ].filter(Boolean);
  return (
    <li className="support__row">
      <span className="support__row-main">
        {tour.publish ? (
          <a href={`${website}/s/${tour.publish.slug}`} target="_blank" rel="noreferrer">
            {tour.title}
          </a>
        ) : (
          <span>{tour.title}</span>
        )}
        <span className="support__meta">{facts.join(' · ')}</span>
      </span>
      <span className="support__actions">
        {tour.publish && (
          <Button size="sm" variant="ghost" onClick={() => onTour(tour.tourId, 'unpublish')}>
            Unpublish
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onTour(tour.tourId, tour.hiddenFromExplore ? 'unhide' : 'hide')}
        >
          {tour.hiddenFromExplore ? 'Show on Explore' : 'Hide from Explore'}
        </Button>
      </span>
    </li>
  );
}
