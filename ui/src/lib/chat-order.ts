import { useCallback, useSyncExternalStore } from "react";

/**
 * Your own order for chats (Move up / Move down), per organization and
 * person, kept on this device. Pins themselves are stars on the server, so
 * they follow you everywhere.
 */
const EVENT = "automa:chat-order";
const key = (company: string, user?: string | null) => `automa.chatOrder:${company}:${user ?? "__local_board__"}`;
const memory = new Map<string, string>();

function read(storageKey: string): string {
  try {
    return window.localStorage.getItem(storageKey) ?? memory.get(storageKey) ?? "[]";
  } catch {
    return memory.get(storageKey) ?? "[]";
  }
}

export function parseChatOrder(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
  } catch {
    return [];
  }
}

function write(storageKey: string, ids: string[]) {
  const value = JSON.stringify(ids);
  memory.set(storageKey, value);
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    // Reordering still works for this session without storage.
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

/** Sorts `ids` by the saved order; ids without a saved place keep their incoming order after the saved ones. */
export function applyChatOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ra = rank.get(a.item.id);
      const rb = rank.get(b.item.id);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/** Moves `id` one place up or down within `visibleIds` and saves the full order. */
export function moveInOrder(visibleIds: string[], id: string, direction: -1 | 1): string[] {
  const next = [...visibleIds];
  const index = next.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function useChatOrder(company: string, user?: string | null) {
  const storageKey = key(company, user);
  const getSnapshot = useCallback(() => read(storageKey), [storageKey]);
  const order = parseChatOrder(useSyncExternalStore(subscribe, getSnapshot, () => "[]"));
  const move = useCallback(
    (visibleIds: string[], id: string, direction: -1 | 1) => {
      const moved = moveInOrder(visibleIds, id, direction);
      const rest = parseChatOrder(read(storageKey)).filter((existing) => !moved.includes(existing));
      write(storageKey, [...moved, ...rest]);
    },
    [storageKey],
  );
  return { order, move };
}
