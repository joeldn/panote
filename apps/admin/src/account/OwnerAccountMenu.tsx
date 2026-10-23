import { AccountMenu } from '@internal/ui';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useAuthEnv } from '../auth-context.js';
import type { Session } from '../session.js';
import {
  DELETE_ACCOUNT_PARAM,
  DELETE_ACCOUNT_RESUME,
  DeleteAccountModal,
} from './DeleteAccount.js';

/** The account menu every admin page shows: home link, Delete account, sign out. */
export function OwnerAccountMenu({ session }: { session: Session }) {
  const { origins } = useAuthEnv();
  const [params, setParams] = useSearchParams();
  const resuming = params.get(DELETE_ACCOUNT_PARAM) === DELETE_ACCOUNT_RESUME;
  const [deleting, setDeleting] = useState(resuming);
  const [reauthenticated, setReauthenticated] = useState(resuming);

  // Back from signing in again for Delete account: the dialog is open; drop the param
  // so a reload or a shared link doesn't open it again.
  useEffect(() => {
    if (!resuming) return;
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete(DELETE_ACCOUNT_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [resuming, setParams]);
  return (
    <>
      <AccountMenu
        user={session.user}
        items={[
          { label: 'Home page', icon: 'fa-solid fa-house', href: `${origins.website}/` },
          {
            label: 'Delete account',
            icon: 'fa-solid fa-trash-can',
            danger: true,
            onSelect: () => setDeleting(true),
          },
        ]}
        onSignOut={session.signOut}
      />
      <DeleteAccountModal
        open={deleting}
        session={session}
        reauthenticated={reauthenticated}
        onClose={() => {
          setDeleting(false);
          setReauthenticated(false);
        }}
      />
    </>
  );
}
