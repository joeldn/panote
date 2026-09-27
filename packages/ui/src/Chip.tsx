import type { MouseEventHandler, ReactNode } from 'react';

import { cx } from './cx.js';

export type ChipTone = 'dark' | 'accent' | 'light';

export interface ChipProps {
  children: ReactNode;
  tone?: ChipTone;
  /** Font Awesome classes for a leading icon, e.g. `fa-solid fa-globe`. */
  icon?: string;
  /** Mono uppercase label style (kickers, "Featured tour"). */
  mono?: boolean;
  /** Makes the chip a button, e.g. the dashboard visibility toggle. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  title?: string;
  className?: string;
  'aria-label'?: string;
}

export function Chip({
  children,
  tone = 'dark',
  icon,
  mono,
  onClick,
  className,
  ...rest
}: ChipProps) {
  const cls = cx('pn-chip', `pn-chip--${tone}`, mono && 'pn-chip--mono', className);
  const content = (
    <>
      {icon && <i className={cx('pn-chip__icon', icon)} aria-hidden="true" />}
      {children}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} {...rest}>
        {content}
      </button>
    );
  }
  return (
    <span className={cls} {...rest}>
      {content}
    </span>
  );
}
