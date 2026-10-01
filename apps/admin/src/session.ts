import {
  createAdminApi,
  createUploadApi,
  isAuthError,
  type AdminApi,
  type Auth,
  type AuthUser,
  type FetchLike,
  type UploadApi,
} from '@internal/web-kit';
import { createContext, useContext } from 'react';

export interface Session {
  user: AuthUser;
  api: AdminApi;
  /** The presign route (`/api/upload-url`), on the same session as `api`. */
  upload: UploadApi;
  /** Opens the "session ended" sign-in prompt. */
  requestSignIn(): void;
  /** Holds the sign-in redirect until `work` settles, e.g. stashing a file that must survive it. */
  holdSignIn(work: Promise<unknown>): void;
  signOut(): Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

/** The signed-in session; only valid under `RequireAuth`. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside RequireAuth');
  return session;
}

export const useOptionalSession = (): Session | null => useContext(SessionContext);

export interface SessionApiOptions {
  baseUrl: string;
  fetch?: FetchLike;
}

/**
 * The admin API with Auth0 access tokens. Any "sign in again" failure (a gone
 * refresh token or an API 401) calls `onAuthError` before it rejects.
 */
export function createSessionApi(
  auth: Pick<Auth, 'getAccessToken'>,
  onAuthError: () => void,
  opts: SessionApiOptions,
): AdminApi {
  const api = createAdminApi({
    getToken: () => auth.getAccessToken(),
    baseUrl: opts.baseUrl,
    ...(opts.fetch && { fetch: opts.fetch }),
  });
  return withAuthErrors(api, onAuthError);
}

/** The upload API (presign) with the same token source and auth-error hook as the admin API. */
export function createSessionUploadApi(
  auth: Pick<Auth, 'getAccessToken'>,
  onAuthError: () => void,
  opts: SessionApiOptions,
): UploadApi {
  const api = createUploadApi({
    getToken: () => auth.getAccessToken(),
    baseUrl: opts.baseUrl,
    ...(opts.fetch && { fetch: opts.fetch }),
  });
  return withAuthErrors(api, onAuthError);
}

function withAuthErrors<T extends object>(api: T, onAuthError: () => void): T {
  const wrapped = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(api) as [string, (...a: unknown[]) => unknown][]) {
    wrapped[name] = async (...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch (e) {
        if (isAuthError(e)) onAuthError();
        throw e;
      }
    };
  }
  return wrapped as T;
}
