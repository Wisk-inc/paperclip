import { useCallback, useLayoutEffect, useRef } from "react";

const MAX_DEPTH = 12;

/**
 * True when two plain data values hold the same content. Functions and other
 * class instances compare by identity; anything nested deeper than the limit
 * counts as different, so the answer is never a false "same".
 */
export function structurallyEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (depth >= MAX_DEPTH) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!structurallyEqual(a[index], b[index], depth + 1)) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const protoA = Object.getPrototypeOf(a);
  if (protoA !== Object.getPrototypeOf(b) || (protoA !== Object.prototype && protoA !== null)) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!structurallyEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth + 1)) {
      return false;
    }
  }
  return true;
}

/**
 * Keeps the previous object for every entry whose content did not change, so
 * memoized rows can skip redrawing settled entries when the list is rebuilt.
 */
export function useStableEntries<T>(entries: T[], keyOf: (entry: T) => string): T[] {
  const previousRef = useRef<{ input: T[]; output: T[]; byKey: Map<string, T> } | null>(null);
  const previous = previousRef.current;
  if (previous && previous.input === entries) return previous.output;
  const byKey = new Map<string, T>();
  let changed = !previous || previous.output.length !== entries.length;
  const output = entries.map((entry, index) => {
    const key = keyOf(entry);
    const old = previous?.byKey.get(key);
    const kept = old !== undefined && structurallyEqual(old, entry) ? old : entry;
    if (!changed && previous!.output[index] !== kept) changed = true;
    byKey.set(key, kept);
    return kept;
  });
  const result = changed || !previous ? output : previous.output;
  previousRef.current = { input: entries, output: result, byKey };
  return result;
}

/** The same value as last time when its content did not change. */
export function useStableValue<T>(value: T): T {
  const ref = useRef(value);
  if (!structurallyEqual(ref.current, value)) ref.current = value;
  return ref.current;
}

/**
 * A callback that keeps one identity while it stays defined and always calls
 * the latest function. Undefined stays undefined, so "no handler" still shows.
 */
export function useLatestCallback<Args extends unknown[], Result>(
  fn: ((...args: Args) => Result) | undefined,
): ((...args: Args) => Result) | undefined {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  // A row may still hold the wrapper for a moment after the handler goes
  // away; calling it then does nothing instead of throwing.
  const stable = useCallback((...args: Args) => ref.current?.(...args) as Result, []);
  return fn ? stable : undefined;
}
