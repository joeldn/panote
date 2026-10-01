import type { AppOrigins, Auth, FetchLike } from '@internal/web-kit';
import { createContext, useContext } from 'react';

export interface AuthEnv {
  auth: Auth;
  origins: AppOrigins;
  /** Full-page navigation (Auth0, the website); injectable because jsdom can't navigate. */
  assign: (url: string) => void;
  /** API base (`''` = same-origin) and fetch, passed to the admin API client. */
  apiBase: string;
  fetch?: FetchLike;
}

export const AuthEnvContext = createContext<AuthEnv | null>(null);

export function useAuthEnv(): AuthEnv {
  const env = useContext(AuthEnvContext);
  if (!env) throw new Error('useAuthEnv outside AuthEnvContext');
  return env;
}
