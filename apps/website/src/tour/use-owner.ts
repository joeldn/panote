import { useEffect, useState } from 'react';

import { useAccount } from '../account.js';
import { useAuthEnv } from '../auth-context.js';
import { useConfig } from '../config-context.js';

/**
 * True once the signed-in visitor's own `GET /api/admin/tours/:id` returns 200
 * with JSON (plan 4.3, row 05). Signed out, nothing is requested. A 401, 403,
 * 404, network or token error leaves it false, and so does an HTML page an SPA
 * fallback answers with. Only the status and content type matter, so this is a
 * plain fetch: the admin client and its schemas would weigh down every /s visit.
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
    const url = `${apiBase.replace(/\/+$/, '')}/api/admin/tours/${encodeURIComponent(tourId)}`;
    auth
      .getAccessToken()
      .then((token) =>
        fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: ac.signal,
        }),
      )
      .then(
        (res) => {
          const json = res.ok && res.headers.get('content-type')?.includes('application/json');
          if (json && !ac.signal.aborted) setOwnerOf(tourId);
        },
        () => {
          // Not the owner as far as this page is concerned; the button just stays hidden.
        },
      );
    return () => ac.abort();
  }, [signedIn, auth, apiBase, tourId]);

  return signedIn && ownerOf === tourId;
}
