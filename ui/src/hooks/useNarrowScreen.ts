import { useEffect, useState } from "react";

const QUERY = "(max-width: 767px)";

/** True below the `md` breakpoint, where screens show one pane at a time. */
export function useNarrowScreen() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}
