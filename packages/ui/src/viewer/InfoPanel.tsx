import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

export interface InfoPanelProps {
  /** For the button's aria-controls. */
  id?: string;
  /** The tour's title, the panel's heading. */
  title: string;
  /** The tour's description, plain text. */
  description?: string | undefined;
  /** The scene on screen's title, over its description. */
  sceneTitle?: string | undefined;
  /** The scene on screen's description, plain text. */
  sceneDescription?: string | undefined;
  onClose: () => void;
  /** Takes focus back when the panel closes (the button that opened it). */
  returnFocus?: RefObject<HTMLElement | null>;
}

/**
 * About this tour: its description and the scene on screen's, in the info-point
 * panel's place (a side panel on desktop, a bottom sheet at <=600px). The text is
 * plain: React escapes it, and CSS keeps its line breaks.
 */
export function InfoPanel({
  id,
  title,
  description,
  sceneTitle,
  sceneDescription,
  onClose,
  returnFocus,
}: InfoPanelProps) {
  const panel = useRef<HTMLElement>(null);
  const back = useRef(returnFocus);
  useEffect(() => {
    back.current = returnFocus;
  });
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    return () => {
      const el = back.current?.current;
      if (el?.isConnected) el.focus({ preventScroll: true });
    };
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  };

  return (
    <aside
      ref={panel}
      id={id}
      className="pn-hspanel pn-info"
      aria-label="About this tour"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="pn-hspanel__head">
        <i className="pn-hspanel__icon fa-solid fa-circle-info" aria-hidden="true" />
        <h2 className="pn-hspanel__title">{title}</h2>
        <button type="button" className="pn-hspanel__close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      {description && <p className="pn-info__text">{description}</p>}
      {sceneDescription && (
        <section className="pn-info__scene">
          {sceneTitle && <h3 className="pn-info__label">{sceneTitle}</h3>}
          <p className="pn-info__text">{sceneDescription}</p>
        </section>
      )}
    </aside>
  );
}
