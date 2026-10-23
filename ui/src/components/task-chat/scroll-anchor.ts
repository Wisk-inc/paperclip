/** Keep a reading position by logical row identity, not total scroll height. */
export interface ThreadScrollAnchor {
  id: string;
  top: number;
}

export function readThreadScrollAnchor(root: Element, viewportTop: number, viewportBottom: number): ThreadScrollAnchor | null {
  const rows = root.querySelectorAll<HTMLElement>("[data-thread-anchor]");
  // Rows run top to bottom, so the first one reaching the viewport is found
  // by halving. This runs on every scroll; measuring each row from the top
  // of a long thread was slow on phones.
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].getBoundingClientRect().bottom > viewportTop) high = middle;
    else low = middle + 1;
  }
  for (let index = low; index < rows.length; index += 1) {
    const row = rows[index];
    const rect = row.getBoundingClientRect();
    if (rect.top >= viewportBottom) break;
    if (rect.height > 0 && rect.bottom > viewportTop) {
      return { id: row.dataset.threadAnchor!, top: rect.top - viewportTop };
    }
  }
  return null;
}

export function threadScrollAnchorDelta(root: Element, anchor: ThreadScrollAnchor | null, viewportTop: number): number {
  if (!anchor) return 0;
  // IDs are opaque and need not be safe CSS selectors.
  for (const row of root.querySelectorAll<HTMLElement>("[data-thread-anchor]")) {
    if (row.dataset.threadAnchor === anchor.id) {
      return row.getBoundingClientRect().top - viewportTop - anchor.top;
    }
  }
  return 0;
}
