import { signInPath } from '@internal/web-kit';
import type { ComponentPropsWithRef } from 'react';
import { Link } from 'react-router';

import { useAccount } from './account.js';
import { useAuthEnv } from './auth-context.js';

/** Admin route that resumes an upload (Q1): a stashed dropped file, else the picker. */
export const UPLOAD_RESUME_PATH = '/app/new?resume=upload';

/**
 * Starts an upload: signed in, straight to the admin app; otherwise via the
 * sign-in modal, which returns to the same admin route afterwards.
 */
export function UploadLink(props: Omit<ComponentPropsWithRef<'a'>, 'href'>) {
  const { origins } = useAuthEnv();
  const account = useAccount();
  if (account.status === 'signed-in') {
    return <a {...props} href={`${origins.admin}${UPLOAD_RESUME_PATH}`} />;
  }
  return <Link {...props} to={signInPath(UPLOAD_RESUME_PATH)} />;
}
