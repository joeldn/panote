import { AccountMenu } from '@internal/ui';
import { useState } from 'react';

import { useAuthEnv } from '../auth-context.js';
import type { Session } from '../session.js';
import { DeleteAccountModal } from './DeleteAccount.js';

/** The account menu every admin page shows: home link, Delete account, sign out. */
export function OwnerAccountMenu({ session }: { session: Session }) {
  const { origins } = useAuthEnv();
  const [deleting, setDeleting] = useState(false);
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
      <DeleteAccountModal open={deleting} session={session} onClose={() => setDeleting(false)} />
    </>
  );
}
