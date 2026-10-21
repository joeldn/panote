import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';

import { pointIcon } from '../icons/names.js';
import { renderMarkdown } from '../markdown.js';
import { usePanoViewer } from '../viewer-context.js';
import { MediaEmbed } from './MediaEmbed.js';
import type { ViewerHotspot } from './types.js';

export interface HotspotPanelProps {
  hotspot: ViewerHotspot;
  onClose: () => void;
}

/** The point's HotspotMarkers button, rendered alongside the panel (as TourViewer does). */
function markerFor(panel: HTMLElement | null, id: string): HTMLElement | null {
  const markers = panel?.parentElement?.querySelectorAll<HTMLElement>('[data-hotspot-id]') ?? [];
  for (const el of markers) if (el.dataset.hotspotId === id) return el;
  return null;
}

/** Info-point panel: a side panel on desktop, a bottom sheet at <=600px (CSS). */
export function HotspotPanel({ hotspot, onClose }: HotspotPanelProps) {
  // renderMarkdown escapes all HTML first and only allows http(s)/mailto/relative links.
  const html = useMemo(() => (hotspot.body ? renderMarkdown(hotspot.body) : ''), [hotspot.body]);

  // Keyboard and screen-reader users land in the panel when a point opens, and
  // go back to its marker when it closes. Switching points while open re-focuses
  // the panel and hands focus to the newer point's marker. The marker is looked up,
  // not taken from document.activeElement: Safari doesn't focus a tapped button.
  // A marker the camera has turned away from is hidden and can't take focus, so
  // the viewer takes it instead, as when a focused marker hides.
  const panel = useRef<HTMLElement>(null);
  const marker = useRef<HTMLElement | null>(null);
  const stageViewer = usePanoViewer();
  const viewer = useRef(stageViewer);
  useEffect(() => {
    viewer.current = stageViewer;
  });
  useEffect(() => {
    marker.current = markerFor(panel.current, hotspot.id);
    panel.current?.focus({ preventScroll: true });
  }, [hotspot.id]);
  useEffect(
    () => () => {
      const el = marker.current;
      if (!el?.isConnected) return;
      if (viewer.current && getComputedStyle(el).visibility === 'hidden') viewer.current.focus();
      else el.focus({ preventScroll: true });
    },
    [],
  );
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  };

  return (
    <aside
      ref={panel}
      className="pn-hspanel"
      aria-label={hotspot.title}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="pn-hspanel__head">
        <i
          className={`pn-hspanel__icon fa-solid fa-${pointIcon(hotspot.icon)}`}
          aria-hidden="true"
        />
        <h2 className="pn-hspanel__title">{hotspot.title}</h2>
        <button type="button" className="pn-hspanel__close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      {hotspot.media && <MediaEmbed key={hotspot.id} media={hotspot.media} title={hotspot.title} />}
      {html && <div className="pn-hspanel__body" dangerouslySetInnerHTML={{ __html: html }} />}
    </aside>
  );
}
