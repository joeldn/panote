import { safeReturnTo } from '@internal/web-kit';

// Fixed copy per Auth0/spa-js error code; the raw text comes from the URL, so never headline it.
const COPY: Record<string, string> = {
  access_denied: 'Sign-in was cancelled, or this account isn’t allowed to sign in.',
  login_required: 'Your sign-in expired before it finished. Please sign in again.',
  consent_required: 'panote needs your permission to sign you in. Please try again.',
  interaction_required: 'Your sign-in needs another step. Please try again.',
  state_mismatch: 'This sign-in link has expired or was already used. Please start again.',
  missing_transaction: 'This sign-in link has expired or was already used. Please start again.',
  invalid_request: 'The sign-in request was rejected. Please try again.',
  unauthorized: 'This account isn’t allowed to sign in.',
  temporarily_unavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
  server_error: 'Sign-in failed on the provider’s side. Please try again shortly.',
};
const FALLBACK = 'Something went wrong while signing you in. Please try again.';

export interface CallbackError {
  message: string;
  /** The raw SDK text, shown only behind a disclosure. */
  detail: string;
  /** The original destination, re-validated, if the SDK error still carries it. */
  next?: string;
}

const field = (e: unknown, key: string): unknown =>
  e && typeof e === 'object' && key in e ? (e as Record<string, unknown>)[key] : undefined;

export function describeCallbackError(e: unknown, adminOrigin: string): CallbackError {
  const code = field(e, 'error');
  const message = (typeof code === 'string' && COPY[code]) || FALLBACK;
  const detail = e instanceof Error ? e.message : String(e);
  const returnTo = field(field(e, 'appState'), 'returnTo');
  if (typeof returnTo !== 'string') return { message, detail };
  return { message, detail, next: safeReturnTo(returnTo, adminOrigin) };
}
