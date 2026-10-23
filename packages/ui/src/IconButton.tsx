import type { ComponentPropsWithRef } from 'react';

import { cx } from './cx.js';

export interface IconButtonProps extends Omit<
  ComponentPropsWithRef<'button'>,
  'children' | 'aria-label'
> {
  /** Font Awesome classes, e.g. `fa-solid fa-xmark`. */
  icon: string;
  /** The button's accessible name: an icon alone says nothing to a screen reader. */
  label: string;
  /**
   * `md` is a 32px square; `sm` draws at 26px for dense rows and still takes presses
   * over 32px.
   */
  size?: 'sm' | 'md';
}

/** A quiet icon-only button: transparent until hovered, named by `label`. */
export function IconButton({
  icon,
  label,
  size = 'md',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      className={cx('pn-icon-btn', size === 'sm' && 'pn-icon-btn--sm', className)}
    >
      <i className={icon} aria-hidden="true" />
    </button>
  );
}
