import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

/**
 * A menu button's behaviour: opening focuses the first item, the arrow keys walk the items
 * (Home and End jump), Esc closes back onto the button, Tab or a press outside just closes.
 */
export function useMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
      // The editor's own Esc (cancel placing or a move) isn't for this.
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return {
    open,
    close,
    rootProps: { ref: root },
    buttonProps: {
      ref: button,
      'aria-haspopup': 'menu' as const,
      'aria-expanded': open,
      'aria-controls': open ? menuId : undefined,
      onClick: () => setOpen((o) => !o),
    },
    menuProps: { ref: menu, id: menuId, role: 'menu', onKeyDown },
  };
}
