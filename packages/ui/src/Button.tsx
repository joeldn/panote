import type { ComponentPropsWithRef } from 'react';

import { cx } from './cx.js';

export type ButtonVariant = 'primary' | 'accent' | 'danger' | 'ghost' | 'glass';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  pill?: boolean;
  /** Font Awesome classes, e.g. `fa-solid fa-plus`. */
  icon?: string;
  /** Shows a spinner and disables the button while an action runs. */
  busy?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  pill = false,
  icon,
  busy = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'pn-btn',
        `pn-btn--${variant}`,
        size !== 'md' && `pn-btn--${size}`,
        pill && 'pn-btn--pill',
        className,
      )}
    >
      {busy ? (
        <span className="pn-btn__spinner" aria-hidden="true" />
      ) : (
        icon && <i className={icon} aria-hidden="true" />
      )}
      {children}
    </button>
  );
}
