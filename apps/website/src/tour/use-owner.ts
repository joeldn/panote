import { createAdminApi } from '@internal/web-kit';
import { useEffect, useState } from 'react';

import { useAccount } from '../account.js';
import { useAuthEnv } from '../auth-context.js';
import { useConfig } from '../config-context.js';

/**
 * True once the signed-in visitor's own `GET /api/admin/tours/:id` returns 200
 * (plan 4.3, row 05). Signed out, nothing is requested; any 403, 404, network
 * or token error leaves it false.
 */
export function useIsOwner(tourId: string): boolean {
  const { auth } = useAuthEnv();
  const { apiBase } = useConfig();
  const account = useAccount();
  const signedIn = account.status === 'signed-in';
  const [ownerOf, setOwnerOf] = useState<string | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    const ac = new AbortController();
    const api = createAdminApi({
      getToken: () => auth.getAccessToken(),
      baseUrl: apiBase,
      fetch: (input, init) => globalThis.fetch(input, { ...init, signal: ac.signal }),
    });
    api.getTour(tourId).then(
      (result) => {
        if (!ac.signal.aborted && result.status === 'ok') setOwnerOf(tourId);
      },
      () => {
        // Not the owner as far as this page is concerned; the button just stays hidden.
      },
    );
    return () => ac.abort();
  }, [signedIn, auth, apiBase, tourId]);

  return signedIn && ownerOf === tourId;
}
