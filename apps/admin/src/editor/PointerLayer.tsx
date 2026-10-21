import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';

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
  /** Moves once a press has turned into a drag, at most one per animation frame. */
  onDrag: (at: LayerPoint, start: LayerPoint) => void;
  /** The drag's release, with its final spot (any move still waiting for a frame is dropped). */
  onDragEnd: (at: LayerPoint, start: LayerPoint) => void;
  /** The browser cancelled the drag (pointercancel): undo whatever it did. */
  onCancel: () => void;
}

const at = (e: { clientX: number; clientY: number; currentTarget: Element }): LayerPoint => {
  const rect = e.currentTarget.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
};

/**
 * Covers the stage while placing or moving a point: tells a click from a drag, and
 * keeps the stage from panning underneath. Esc is the editor's (a document listener).
 */
export function PointerLayer({
  className,
  hint,
  onPick,
  onDrag,
  onDragEnd,
  onCancel,
}: PointerLayerProps) {
  const press = useRef<{ start: LayerPoint; id: number; dragging: boolean } | null>(null);
  // A drag ends on pointerup; the click the browser sends after it isn't a pick.
  const swallowClick = useRef(false);
  // Drag moves go out at most once a frame, the latest one winning.
  const frame = useRef<{ handle: number; at: LayerPoint; start: LayerPoint } | null>(null);
  const dropFrame = () => {
    if (frame.current) cancelAnimationFrame(frame.current.handle);
    frame.current = null;
  };
  useEffect(() => dropFrame, []);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    // One press at a time: a second finger mid-drag doesn't start another.
    if (e.button !== 0 || press.current) return;
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
    if (frame.current) {
      frame.current.at = here;
      return;
    }
    const handle = requestAnimationFrame(() => {
      const f = frame.current;
      frame.current = null;
      if (f) onDrag(f.at, f.start);
    });
    frame.current = { handle, at: here, start: p.start };
  };
  /** Ends this pointer's press; its start when it was a drag (whose click is then swallowed). */
  const release = (e: PointerEvent<HTMLDivElement>): LayerPoint | null => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return null;
    press.current = null;
    dropFrame();
    if (!p.dragging) return null;
    swallowClick.current = true;
    return p.start;
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const start = release(e);
    if (start) onDragEnd(at(e), start);
  };
  // The browser took the pointer (a scroll, a system gesture): undo the drag, don't commit it.
  const cancel = (e: PointerEvent<HTMLDivElement>) => {
    if (release(e)) onCancel();
  };
  const click = (e: MouseEvent<HTMLDivElement>) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    // Another pointer's tap while one is pressed isn't a pick either.
    if (press.current) return;
    onPick(at(e));
  };

  return (
    <div
      className={className}
      role="presentation"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      // Capture lost without a pointerup (it also follows one, by then a no-op): the press
      // must not stay open, or every later click would be ignored as a second pointer.
      onLostPointerCapture={cancel}
      onClick={click}
    >
      <span className="ed-placing__hint">{hint}</span>
    </div>
  );
}
