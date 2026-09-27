import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { cx } from './cx.js';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Card max-width in px: 392 sign-in/confirm, 440 share, 560 upload/insights. */
  width?: number;
  /** Corner radius in px (20 by default, 18 for confirm). */
  radius?: number;
  /** Id of the element naming the dialog; ModalHeader wires this up for you. */
  labelledBy?: string;
  'aria-label'?: string;
  /** Whether a click on the scrim closes the modal (default true). */
  closeOnScrim?: boolean;
  className?: string;
  /** Portal target; defaults to document.body so tokens on :root still apply. */
  container?: Element;
}

/**
 * Dialog on a blurred scrim, portalled to <body>. Escape and a scrim click
 * close it; focus moves in on open, is trapped, and returns on close.
 */
export function Modal({
  open,
  onClose,
  children,
  width = 440,
  radius,
  labelledBy,
  closeOnScrim = true,
  className,
  container,
  'aria-label': ariaLabel,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const pressedOnScrim = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>('[autofocus],[data-autofocus]');
    (first ?? dialog)?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous && previous.isConnected) previous.focus();
    };
  }, [open]);

  if (!open) return null;

  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === firstItem || active === dialogRef.current)) {
      e.preventDefault();
      lastItem?.focus();
    } else if (!e.shiftKey && active === lastItem) {
      e.preventDefault();
      firstItem?.focus();
    }
  };

  // Only a press that starts and ends on the scrim closes: a text selection
  // dragged out of the card must not dismiss it.
  const onScrimDown = (e: MouseEvent<HTMLDivElement>) => {
    pressedOnScrim.current = e.target === e.currentTarget;
  };
  const onScrimClick = (e: MouseEvent<HTMLDivElement>) => {
    if (closeOnScrim && pressedOnScrim.current && e.target === e.currentTarget) onClose();
    pressedOnScrim.current = false;
  };

  const style = { '--pn-modal-width': `${width}px` } as CSSProperties & Record<string, string>;
  if (radius !== undefined) style['--pn-modal-radius'] = `${radius}px`;

  return createPortal(
    <div className="pn-scrim" onMouseDown={onScrimDown} onClick={onScrimClick}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : ariaLabel}
        tabIndex={-1}
        className={cx('pn-modal', className)}
        style={style}
        onKeyDown={trapTab}
      >
        {children}
      </div>
    </div>,
    container ?? document.body,
  );
}

export interface ModalHeaderProps {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
}

/** Sticky header row: 600 17px title, optional mono subtitle, and the × button. */
export function ModalHeader({ id, title, subtitle, onClose }: ModalHeaderProps) {
  return (
    <div className="pn-modal__header">
      <div>
        <h2 id={id} className="pn-modal__title">
          {title}
        </h2>
        {subtitle && <p className="pn-modal__subtitle">{subtitle}</p>}
      </div>
      <button type="button" className="pn-modal__close" aria-label="Close" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
