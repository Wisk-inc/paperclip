import { useEffect, useState } from "react";

/**
 * Narrower than App Studio's three columns need (file tree, editor and side
 * panel side by side), or too short for them (a phone held sideways). The
 * Find panel's layout in index.css uses the same query.
 */
export const NARROW_SCREEN_QUERY = "(max-width: 1180px), (max-height: 519px)";

/** True where screens show one pane at a time: phones in either direction, and tablets. */
export function useNarrowScreen() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(NARROW_SCREEN_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(NARROW_SCREEN_QUERY);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}
