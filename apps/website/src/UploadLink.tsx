import { signInPath } from '@internal/web-kit';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Link } from 'react-router';

import { useAccount } from './account.js';
import { useAuthEnv } from './auth-context.js';

/** Admin route that resumes an upload (Q1): a stashed dropped file, else the picker. */
export const UPLOAD_RESUME_PATH = '/app/new?resume=upload';

export type UploadLinkProps = Omit<ComponentPropsWithRef<'a'>, 'href' | 'children'> & {
  /** A function gets whether this browser is signed in, for copy that differs (C10). */
  children?: ReactNode | ((signedIn: boolean) => ReactNode);
};

/**
 * Starts an upload: signed in, straight to the admin app; otherwise via the
 * sign-in modal, which returns to the same admin route afterwards.
 */
export function UploadLink({ children, ...props }: UploadLinkProps) {
  const { origins } = useAuthEnv();
  const account = useAccount();
  const signedIn = account.status === 'signed-in';
  const content = typeof children === 'function' ? children(signedIn) : children;
  if (signedIn) {
    return (
      <a {...props} href={`${origins.admin}${UPLOAD_RESUME_PATH}`}>
        {content}
      </a>
    );
  }
  return (
    <Link {...props} to={signInPath(UPLOAD_RESUME_PATH)}>
      {content}
    </Link>
  );
}
