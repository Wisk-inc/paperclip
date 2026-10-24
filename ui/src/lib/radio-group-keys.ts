import type { KeyboardEvent } from "react";

const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Keys for a hand-built radiogroup, as the WAI-ARIA radio pattern has them:
 * the arrows (and Home / End) move to another radio and select it. Put this
 * on the element with role="radiogroup", and give its radios
 * `radioTabIndex` so the group is one stop in the Tab order.
 */
export function handleRadioGroupKeyDown(event: KeyboardEvent<HTMLElement>, select: (index: number) => void) {
  const step = STEPS[event.key];
  if (step === undefined && event.key !== "Home" && event.key !== "End") return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
  const index = radios.indexOf(document.activeElement as HTMLElement);
  if (index === -1 || radios.length === 0) return;
  event.preventDefault();
  const next =
    event.key === "Home" ? 0
      : event.key === "End" ? radios.length - 1
        : (index + step + radios.length) % radios.length;
  radios[next].focus();
  select(next);
}

/** Only the checked radio (or the first, when none is) is a Tab stop. */
export function radioTabIndex(selected: boolean, index: number, anySelected: boolean): 0 | -1 {
  return selected || (!anySelected && index === 0) ? 0 : -1;
}
