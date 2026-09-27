import type { AppOrigins, Auth } from '@internal/web-kit';
import { createContext, useContext } from 'react';

export interface AuthEnv {
  auth: Auth;
  origins: AppOrigins;
}

export const AuthEnvContext = createContext<AuthEnv | null>(null);

export function useAuthEnv(): AuthEnv {
  const env = useContext(AuthEnvContext);
  if (!env) throw new Error('useAuthEnv outside AuthEnvContext');
  return env;
}
