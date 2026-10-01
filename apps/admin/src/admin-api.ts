import { AuthRequiredError, createAdminApi, type AdminApi } from '@internal/web-kit';
import { createContext, useContext, useMemo } from 'react';

import { useConfig } from './config-context.js';

/** The signed-in admin API. Until sign-in (unit C3) provides one, every call needs sign-in. */
export const AdminApiContext = createContext<AdminApi | null>(null);

export function useAdminApi(): AdminApi {
  const provided = useContext(AdminApiContext);
  const { apiBase } = useConfig();
  const signedOut = useMemo(
    () =>
      createAdminApi({
        baseUrl: apiBase,
        getToken: () => Promise.reject(new AuthRequiredError('not signed in')),
      }),
    [apiBase],
  );
  return provided ?? signedOut;
}
