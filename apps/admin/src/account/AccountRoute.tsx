import '../dashboard/dashboard.css';
import './account.css';

import { MAX_TOURS_PER_OWNER, type AccountView, type UploadUsage } from '@internal/contracts';
import { Button } from '@internal/ui';
import { KNOWN_CONNECTIONS, type AdminApi } from '@internal/web-kit';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { formatBytes } from '../dashboard/format.js';
import { useSession } from '../session.js';
import { DeleteAccountModal } from './DeleteAccount.js';

type Load<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T };

/** Loads once per `load` (keep it stable), with a retry. */
function useLoad<T>(load: () => Promise<T>): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(
      (value) => live && setState({ status: 'ready', value }),
      () => live && setState({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [load, attempt]);
  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  return [state, retry];
}

/** Every page of the owner's tours, counted (at most MAX_TOURS_PER_OWNER, two pages). */
async function countTours(api: Pick<AdminApi, 'listTours'>): Promise<number> {
  let count = 0;
  let cursor: string | null = null;
  do {
    const page = await api.listTours({ limit: 100, ...(cursor && { cursor }) });
    count += page.tours.length;
    cursor = page.cursor;
  } while (cursor);
  return count;
}

const signInName = (connection: string): string =>
  connection in KNOWN_CONNECTIONS
    ? connection === 'email'
      ? 'Email code'
      : KNOWN_CONNECTIONS[connection as keyof typeof KNOWN_CONNECTIONS].label
    : connection;

function Meter({
  label,
  used,
  max,
  format = String,
}: {
  label: string;
  used: number;
  max: number | null;
  format?: (n: number) => string;
}) {
  const share = max === null || max === 0 ? null : Math.min(1, used / max);
  return (
    <li className="acct__meter">
      <span className="acct__meter-label">{label}</span>
      <span className="acct__meter-value">
        {max === null ? format(used) : `${format(used)} of ${format(max)}`}
      </span>
      {share !== null && (
        <span className="acct__bar" aria-hidden="true">
          <span
            className={`acct__bar-fill${share >= 0.9 ? ' acct__bar-fill--full' : ''}`}
            style={{ width: `${share * 100}%` }}
          />
        </span>
      )}
    </li>
  );
}

function Retry({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="dash__banner dash__banner--warn" role="alert">
      <span>{text}</span>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** /app/account: who is signed in and how, usage against the limits, sign out, delete. */
export function AccountRoute() {
  const session = useSession();
  const { api, upload } = session;
  const [deleting, setDeleting] = useState(false);
  const [account, reloadAccount] = useLoad<AccountView>(useCallback(() => api.getAccount(), [api]));
  const [usage, reloadUsage] = useLoad<UploadUsage & { tours: number }>(
    useCallback(
      async () => ({ ...(await upload.getUsage()), tours: await countTours(api) }),
      [api, upload],
    ),
  );

  return (
    <section className="dash acct">
      <header className="dash__head">
        <div>
          <p className="dash__kicker">
            <Link to="/" className="unused__back">
              <i className="fa-solid fa-arrow-left" aria-hidden="true" /> Your tours
            </Link>
          </p>
          <h1 className="dash__title">Account</h1>
        </div>
      </header>

      <section className="acct__section" aria-labelledby="acct-signin">
        <h2 id="acct-signin" className="dash__kicker">
          Signing in
        </h2>
        {account.status === 'loading' && (
          <p className="app-status" role="status">
            Loading…
          </p>
        )}
        {account.status === 'error' && (
          <Retry text="Couldn’t load your account." onRetry={reloadAccount} />
        )}
        {account.status === 'ready' && (
          <dl className="acct__facts">
            <dt>Email</dt>
            <dd>{account.value.email ?? session.user.email ?? 'Not verified'}</dd>
            <dt>Sign in with</dt>
            <dd>{account.value.signIns.map(signInName).join(', ') || 'Unknown'}</dd>
          </dl>
        )}
        <p className="acct__hint">
          Signing in another way with the same verified email address opens this account too.
        </p>
      </section>

      <section className="acct__section" aria-labelledby="acct-usage">
        <h2 id="acct-usage" className="dash__kicker">
          Usage
        </h2>
        {usage.status === 'loading' && (
          <p className="app-status" role="status">
            Loading…
          </p>
        )}
        {usage.status === 'error' && (
          <Retry text="Couldn’t load your usage." onRetry={reloadUsage} />
        )}
        {usage.status === 'ready' && (
          <>
            <ul className="acct__meters">
              <Meter label="Panos" used={usage.value.panos} max={usage.value.limits.maxPanos} />
              <Meter
                label="Storage"
                used={usage.value.bytes}
                max={usage.value.limits.maxBytes}
                format={formatBytes}
              />
              <Meter
                label="Uploads in the past 24 hours"
                used={usage.value.uploadsToday}
                max={usage.value.limits.maxUploadsPerDay}
              />
              <Meter label="Tours" used={usage.value.tours} max={MAX_TOURS_PER_OWNER} />
            </ul>
            <p className="acct__hint">
              Panote is free within these limits. Tours shared with you count toward their owner’s.
            </p>
          </>
        )}
      </section>

      <section className="acct__section" aria-labelledby="acct-session">
        <h2 id="acct-session" className="dash__kicker">
          Session
        </h2>
        <Button variant="ghost" onClick={() => void session.signOut()}>
          Sign out
        </Button>
      </section>

      <section className="acct__section" aria-labelledby="acct-delete">
        <h2 id="acct-delete" className="dash__kicker">
          Delete account
        </h2>
        <p className="acct__hint">
          Removes every tour and panorama you’ve made, with their share links and view counts. Tours
          other people shared with you stay theirs.
        </p>
        <Button variant="danger" onClick={() => setDeleting(true)}>
          Delete account
        </Button>
      </section>

      <DeleteAccountModal open={deleting} session={session} onClose={() => setDeleting(false)} />
    </section>
  );
}
