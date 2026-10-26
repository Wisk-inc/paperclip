import { useCallback, useRef } from "react";

/**
 * Press-and-hold detection that works for touch and mouse. Fires `onLongPress`
 * after `ms`, and cancels if the pointer moves far or lifts first, so a normal
 * tap or a scroll never triggers it.
 */
export function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    start.current = null;
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    start.current = { x: event.clientX, y: event.clientY };
    timer.current = setTimeout(() => { timer.current = null; onLongPress(); }, ms);
  }, [onLongPress, ms]);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    if (!start.current) return;
    if (Math.abs(event.clientX - start.current.x) > 10 || Math.abs(event.clientY - start.current.y) > 10) clear();
  }, [clear]);

  return { onPointerDown, onPointerMove, onPointerUp: clear, onPointerCancel: clear, onPointerLeave: clear };
}
