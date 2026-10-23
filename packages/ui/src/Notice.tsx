import type { AriaRole, ReactNode } from 'react';

import { cx } from './cx.js';

export type NoticeTone = 'info' | 'warn' | 'error';

export interface NoticeProps {
  tone?: NoticeTone;
  children: ReactNode;
  /** Buttons at the right (they drop under the text when the row is narrow). */
  actions?: ReactNode;
  /** Font Awesome classes for a leading icon, e.g. `fa-solid fa-spinner fa-spin`. */
  icon?: string;
  /**
   * How it is announced. By default `info` is a polite `status` and the others an
   * `alert`; `note` (or `none`) for text that is there from the start.
   */
  role?: AriaRole;
  className?: string;
}

const ROLE: Record<NoticeTone, AriaRole> = { info: 'status', warn: 'alert', error: 'alert' };

/** A one-line message in the page's flow, with the actions it offers. */
export function Notice({ tone = 'info', children, actions, icon, role, className }: NoticeProps) {
  return (
    <div className={cx('pn-notice', `pn-notice--${tone}`, className)} role={role ?? ROLE[tone]}>
      {icon && <i className={cx('pn-notice__icon', icon)} aria-hidden="true" />}
      <div className="pn-notice__text">{children}</div>
      {actions && <div className="pn-notice__actions">{actions}</div>}
    </div>
  );
}
