import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';

/** One entry: a route (`to`), a page in a new tab (`href`) or an action (`onSelect`). */
export type CardMenuItem = {
  label: string;
  icon: string;
  danger?: boolean;
  disabled?: boolean;
} & ({ to: string } | { href: string } | { onSelect(): void });

export interface CardMenuProps {
  /** The menu button's accessible name, e.g. `More for “Harbour walk”`. */
  label: string;
  items: CardMenuItem[];
  /** Something the menu started is still running: the button shows a spinner. */
  busy?: boolean;
}

/** A tour card's "⋯" menu: the card's less frequent actions, out of the way until asked for. */
export function CardMenu({ label, items, busy = false }: CardMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  // Opened with ArrowUp: start at the last item, as a menu button does.
  const startAtEnd = useRef(false);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const all = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    (startAtEnd.current ? all[all.length - 1] : all[0])?.focus();
    startAtEnd.current = false;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // On the button, ArrowDown opens at the first item and ArrowUp at the last.
  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    startAtEnd.current = e.key === 'ArrowUp';
    setOpen(true);
  };

  // Focus that leaves for somewhere else closes it. A null target (a press on nothing
  // focusable, or a browser that doesn't focus buttons on click) is left to the
  // outside-press handler, so a click on an item still lands.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (open && to && !root.current?.contains(to)) setOpen(false);
  };

  // Arrow keys walk the items, Home and End jump, Esc and Tab leave.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'ArrowDown'
        ? (at + 1) % all.length
        : e.key === 'ArrowUp'
          ? (at - 1 + all.length) % all.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? all.length - 1
              : null;
    if (next !== null) {
      e.preventDefault();
      all[next]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  const content = (item: CardMenuItem) => (
    <>
      <i className={item.icon} aria-hidden="true" />
      {item.label}
    </>
  );
  const cls = (item: CardMenuItem) =>
    `dash-menu__item${item.danger ? ' dash-menu__item--danger' : ''}`;

  return (
    <div ref={root} className="dash-menu" onBlur={onBlur}>
      <button
        ref={button}
        type="button"
        className="dash-card__action"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-busy={busy || undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKey}
      >
        <i
          className={busy ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-ellipsis'}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className="dash-menu__list"
          role="menu"
          aria-label={label}
          onKeyDown={onKey}
        >
          {items.map((item) =>
            'to' in item ? (
              <Link
                key={item.label}
                role="menuitem"
                className={cls(item)}
                to={item.to}
                onClick={() => close(false)}
              >
                {content(item)}
              </Link>
            ) : 'href' in item ? (
              <a
                key={item.label}
                role="menuitem"
                className={cls(item)}
                href={item.href}
                target="_blank"
                rel="noopener"
                onClick={() => close(false)}
              >
                {content(item)}
              </a>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={cls(item)}
                // Still focusable, so arrow keys don't skip it silently.
                aria-disabled={item.disabled || undefined}
                onClick={() => {
                  if (item.disabled) return;
                  // Focus back on the button first, so a dialog this opens returns there.
                  close(true);
                  item.onSelect();
                }}
              >
                {content(item)}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
