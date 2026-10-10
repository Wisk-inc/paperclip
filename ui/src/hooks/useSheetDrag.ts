import { useCallback, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

const MIN_VH = 32;
const MAX_VH = 94;

/**
 * A bottom sheet the thumb can pull taller: drag the handle up or down, or
 * double-tap it to jump between a comfortable height and nearly the whole
 * screen. Heights are a share of the viewport, so the keyboard and rotation
 * keep working, and the sheet's own content scrolls inside it.
 */
export function useSheetDrag(initialVh = 58) {
  const [vh, setVh] = useState(initialVh);
  const drag = useRef<{ startY: number; startVh: number; moved: boolean } | null>(null);
  const lastTap = useRef(0);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { startY: event.clientY, startVh: vh, moved: false };
    },
    [vh],
  );
  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state) return;
    const delta = ((state.startY - event.clientY) / window.innerHeight) * 100;
    if (Math.abs(delta) > 0.5) state.moved = true;
    setVh(Math.min(MAX_VH, Math.max(MIN_VH, state.startVh + delta)));
  }, []);
  const onPointerUp = useCallback(() => {
    const state = drag.current;
    drag.current = null;
    if (!state || state.moved) return;
    const now = Date.now();
    if (now - lastTap.current < 350) setVh((current) => (current > 80 ? initialVh : MAX_VH));
    lastTap.current = now;
  }, [initialVh]);

  return {
    /** Put on the sheet content: its height follows the handle. */
    style: { height: `${vh}vh`, maxHeight: `${MAX_VH}vh` } satisfies CSSProperties,
    /** Spread on the handle element at the top of the sheet. */
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      role: "separator" as const,
      "aria-label": "Drag up to make the panel taller, down to shrink it; double-tap to expand",
      "aria-orientation": "horizontal" as const,
      style: { touchAction: "none" } satisfies CSSProperties,
    },
    expanded: vh > 80,
  };
}
