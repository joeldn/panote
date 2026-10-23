// What Delete account keeps across the re-auth redirect (see DeleteAccount.tsx).

/** The query param that brings the owner back to this dialog after signing in again. */
export const DELETE_ACCOUNT_PARAM = 'delete-account';
export const DELETE_ACCOUNT_RESUME = 'reauthenticated';

// Which account asked to sign in again, kept across the Auth0 redirect (this tab only),
// so the dialog can refuse to go on if the owner came back as someone else.
const DELETING_SUB_KEY = 'panote:delete-account:sub';

export const rememberDeletingSub = (sub: string | undefined): void => {
  try {
    if (sub) sessionStorage.setItem(DELETING_SUB_KEY, sub);
    else sessionStorage.removeItem(DELETING_SUB_KEY);
  } catch {
    // Blocked storage: the resume can’t be checked, so the dialog refuses it.
  }
};

/** The sub that asked to sign in again, if any. */
export const readDeletingSub = (): string | null => {
  try {
    return sessionStorage.getItem(DELETING_SUB_KEY);
  } catch {
    return null;
  }
};

export const forgetDeletingSub = (): void => rememberDeletingSub(undefined);
