import { useEffect, useId, useRef, useState } from 'react';

export interface AccountUser {
  name?: string;
  email?: string;
}

export interface AccountMenuItem {
  label: string;
  /** Font Awesome classes, e.g. `fa-solid fa-layer-group`. */
  icon: string;
  href: string;
}

export interface AccountMenuProps {
  user: AccountUser;
  /** Links above the divider ("My tours", "Home page"). */
  items?: readonly AccountMenuItem[];
  onSignOut: () => void | Promise<void>;
}

const initialOf = (user: AccountUser): string =>
  (user.name ?? user.email ?? '?').trim().charAt(0).toUpperCase() || '?';

/** The 38px avatar (initial) that opens the name/email + links + "Sign out" menu. */
export function AccountMenu({ user, items = [], onSignOut }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const label = user.name ?? user.email ?? 'Account';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="pn-account" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="pn-account__avatar"
        aria-label={`Account: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        {initialOf(user)}
      </button>
      {open && (
        <div className="pn-account__menu" id={menuId} role="menu" aria-label="Account">
          <div className="pn-account__who">
            {user.name && <div className="pn-account__name">{user.name}</div>}
            {user.email && <div className="pn-account__email">{user.email}</div>}
          </div>
          {items.map((item) => (
            <a key={item.href} role="menuitem" className="pn-account__item" href={item.href}>
              <i className={item.icon} aria-hidden="true" />
              {item.label}
            </a>
          ))}
          {items.length > 0 && <div className="pn-account__divider" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className="pn-account__item pn-account__item--danger"
            onClick={() => {
              setOpen(false);
              void onSignOut();
            }}
          >
            <i className="fa-solid fa-arrow-right-from-bracket" aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
