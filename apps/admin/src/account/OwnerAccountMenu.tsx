import { AccountMenu, type AccountMenuItem } from '@internal/ui';
import { useEffect, useState } from 'react';
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router';

import { isOperator } from '../ops/operator.js';
import type { Session } from '../session.js';
import { AccountModal } from './AccountModal.js';
import { DeleteAccountModal } from './DeleteAccount.js';
import {
  DELETE_ACCOUNT_PARAM,
  DELETE_ACCOUNT_RESUME,
  forgetDeletingSub,
  readDeletingSub,
} from './delete-account-resume.js';

/**
 * The account menu every admin page shows (Account…, Operations for an operator,
 * Sign out), and the windows it opens over the page: Account, then Delete account.
 * They're state here rather than routes, so the editor keeps its unsaved work.
 */
export function OwnerAccountMenu({ session }: { session: Session }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // /app/account: an old link (or bookmark) opens the window over the dashboard.
  const onAccountPath = useMatch('/account') !== null;
  // The page the window was opened over: going to another page (Back, Operations) closes it.
  const { pathname } = useLocation();
  const [openOver, setOpenOver] = useState<string | null>(null);
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpenOver(null);
  }
  const accountOpen = openOver === pathname;
  const [operator, setOperator] = useState(false);
  const resuming = params.get(DELETE_ACCOUNT_PARAM) === DELETE_ACCOUNT_RESUME;
  const [deleting, setDeleting] = useState(resuming);
  const [reauthenticated, setReauthenticated] = useState(resuming);
  // Who asked to sign in again; read once here, forgotten in the effect below.
  const [expectedSub] = useState(() => (resuming ? readDeletingSub() : null));

  // Back from signing in again for Delete account: the dialog is open; drop the param
  // so a reload or a shared link doesn't open it again.
  useEffect(() => {
    if (!resuming) return;
    forgetDeletingSub();
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete(DELETE_ACCOUNT_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [resuming, setParams]);

  const closeAccount = () => {
    setOpenOver(null);
    if (onAccountPath) void navigate('/', { replace: true });
    // The menu item it was opened from has gone: back to the avatar that opened the menu.
    setTimeout(() => document.querySelector<HTMLElement>('.pn-account__avatar')?.focus(), 0);
  };

  const items: AccountMenuItem[] = [
    { label: 'Account…', icon: 'fa-solid fa-user', onSelect: () => setOpenOver(pathname) },
  ];
  if (operator) {
    items.push({
      label: 'Operations',
      icon: 'fa-solid fa-shield-halved',
      onSelect: () => void navigate('/ops'),
    });
  }

  return (
    <>
      <AccountMenu
        user={session.user}
        items={items}
        // Asked when the menu first opens, not on every page load; isOperator keeps the answer.
        onOpen={() => void isOperator(session.api).then((yes) => yes && setOperator(true))}
        onSignOut={session.signOut}
      />
      <AccountModal
        open={accountOpen || onAccountPath}
        session={session}
        onClose={closeAccount}
        onDelete={() => setDeleting(true)}
      />
      <DeleteAccountModal
        open={deleting}
        session={session}
        reauthenticated={reauthenticated}
        expectedSub={expectedSub}
        onClose={() => {
          setDeleting(false);
          setReauthenticated(false);
        }}
      />
    </>
  );
}
