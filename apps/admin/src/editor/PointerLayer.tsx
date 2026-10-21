import { useRef, type PointerEvent, type MouseEvent } from 'react';

/** A spot on the layer, in px from its top-left corner. */
export interface LayerPoint {
  x: number;
  y: number;
}

// Pointer travel (px) before a press counts as a drag rather than a click.
export const DRAG_THRESHOLD = 4;

export interface PointerLayerProps {
  className: string;
  hint: string;
  /** A click with no drag. */
  onPick: (at: LayerPoint) => void;
  /** Each move once a press has turned into a drag (the first one included). */
  onDrag: (at: LayerPoint, start: LayerPoint) => void;
  onDragEnd: (at: LayerPoint, start: LayerPoint) => void;
}

const at = (e: { clientX: number; clientY: number; currentTarget: Element }): LayerPoint => {
  const rect = e.currentTarget.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
};

/**
 * Covers the stage while placing or moving a point: tells a click from a drag, and
 * keeps the stage from panning underneath. Esc is the editor's (a document listener).
 */
export function PointerLayer({ className, hint, onPick, onDrag, onDragEnd }: PointerLayerProps) {
  const press = useRef<{ start: LayerPoint; id: number; dragging: boolean } | null>(null);
  // A drag ends on pointerup; the click the browser sends after it isn't a pick.
  const swallowClick = useRef(false);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    press.current = { start: at(e), id: e.pointerId, dragging: false };
    swallowClick.current = false;
    // Released off the stage still ends the drag here (jsdom has no pointer capture).
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const here = at(e);
    if (!p.dragging) {
      if (Math.hypot(here.x - p.start.x, here.y - p.start.y) < DRAG_THRESHOLD) return;
      p.dragging = true;
    }
    onDrag(here, p.start);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (!p.dragging) return;
    swallowClick.current = true;
    onDragEnd(at(e), p.start);
  };
  const click = (e: MouseEvent<HTMLDivElement>) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    onPick(at(e));
  };

  return (
    <div
      className={className}
      role="presentation"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onClick={click}
    >
      <span className="ed-placing__hint">{hint}</span>
    </div>
  );
}
