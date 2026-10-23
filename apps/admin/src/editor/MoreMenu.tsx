import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';

export interface MoreMenuProps {
  /** The language being edited, as its tag (`en`). */
  lang: string;
  langName: string;
  peopleTo: string;
  insightsTo: string;
  onLanguages: () => void;
  onSettings: () => void;
}

/**
 * The top bar's menu: what a tour needs now and then (its settings, languages, people and
 * insights), so the bar itself keeps to Preview, Save and Share.
 */
export function MoreMenu({
  lang,
  langName,
  peopleTo,
  insightsTo,
  onLanguages,
  onSettings,
}: MoreMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
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

  // Arrow keys walk the items, Home and End jump, Esc and Tab leave.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = items();
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

  return (
    <div ref={root} className="ed-more">
      <button
        ref={button}
        type="button"
        className="ed-glass-btn ed-glass-btn--icon"
        aria-label="Tour menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        // Picking a popover from here mustn't count as a click outside it.
        data-settings-toggle
        data-languages-toggle
        onClick={() => setOpen((o) => !o)}
      >
        <i className="fa-solid fa-ellipsis" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className="ed-more__menu"
          role="menu"
          aria-label="Tour menu"
          onKeyDown={onKey}
        >
          <button
            type="button"
            role="menuitem"
            className="ed-more__item"
            data-settings-toggle
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            <i className="fa-solid fa-sliders" aria-hidden="true" />
            Tour settings
          </button>
          <button
            type="button"
            role="menuitem"
            className="ed-more__item"
            data-languages-toggle
            aria-label={`Languages, editing ${langName}`}
            onClick={() => {
              setOpen(false);
              onLanguages();
            }}
          >
            <i className="fa-solid fa-globe" aria-hidden="true" />
            Languages
            <span className="ed-more__tag">{lang}</span>
          </button>
          <Link
            role="menuitem"
            className="ed-more__item"
            to={peopleTo}
            onClick={() => close(false)}
          >
            <i className="fa-solid fa-user-group" aria-hidden="true" />
            People
          </Link>
          <Link
            role="menuitem"
            className="ed-more__item"
            to={insightsTo}
            onClick={() => close(false)}
          >
            <i className="fa-solid fa-chart-line" aria-hidden="true" />
            Insights
          </Link>
        </div>
      )}
    </div>
  );
}
