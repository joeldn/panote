import { SignInModal } from '@internal/ui';
import { safeReturnTo, type ConnectionId } from '@internal/web-kit';
import { useSearchParams } from 'react-router';

import { useAuthEnv } from './auth-context.js';

/**
 * The sign-in modal, open on any page with `?signin=1`. `next` (checked against
 * the admin origin) is where the callback lands; it defaults to the dashboard.
 */
export function SignInDialog() {
  const { auth, origins } = useAuthEnv();
  const [params, setParams] = useSearchParams();
  const open = params.get('signin') === '1';
  const next = safeReturnTo(params.get('next'), origins.admin);

  const close = () =>
    setParams(
      (p) => {
        p.delete('signin');
        p.delete('next');
        return p;
      },
      { replace: true },
    );

  return (
    <SignInModal
      open={open}
      onClose={close}
      options={auth.configured ? auth.connections : []}
      unavailable="Sign-in isn’t set up for this environment yet."
      onSignIn={(id) => auth.signIn({ connection: id as ConnectionId, returnTo: next })}
    />
  );
}
