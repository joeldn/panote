import { AuthRequiredError, createAdminApi, type AdminApi } from '@internal/web-kit';
import { useMemo } from 'react';

import { useConfig } from './config-context.js';
import { useOptionalSession } from './session.js';

/** The signed-in session's API; outside a session every call needs sign-in. */
export function useAdminApi(): AdminApi {
  const session = useOptionalSession();
  const { apiBase } = useConfig();
  const signedOut = useMemo(
    () =>
      createAdminApi({
        baseUrl: apiBase,
        getToken: () => Promise.reject(new AuthRequiredError('not signed in')),
      }),
    [apiBase],
  );
  return session?.api ?? signedOut;
}
