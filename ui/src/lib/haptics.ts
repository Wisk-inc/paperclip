import { automaNative } from "./automa-native";

/**
 * Haptic vocabulary, kept small so each kind keeps one meaning:
 * - `tick`: a light confirmation that a tap registered (send, tab, toggle).
 * - `thud`: a heavier stop (a limit was reached, an action was blocked).
 * - `success`: a short two-beat sequence when something finished (task created, file sent).
 * - `warning`: a firm sequence when something failed or was declined.
 */
export type HapticKind = "tick" | "thud" | "success" | "warning";

/** Browser fallback patterns in milliseconds (vibrate on, pause, vibrate on). */
const VIBRATION_PATTERNS: Record<HapticKind, number | number[]> = {
  tick: 8,
  thud: 24,
  success: [8, 56, 16],
  warning: [24, 72, 24],
};

function hasTouchInput(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Plays a haptic. Inside the Automa app this uses Android's own haptic
 * feedback (which follows the phone's touch-feedback setting); in a mobile
 * browser it falls back to `navigator.vibrate`; on desktop it does nothing.
 */
export function haptic(kind: HapticKind): void {
  if (typeof window === "undefined") return;
  try {
    if (automaNative.haptic(kind)) return;
    if (!hasTouchInput()) return;
    if (typeof navigator.vibrate === "function") navigator.vibrate(VIBRATION_PATTERNS[kind]);
  } catch {
    // Haptics are an enhancement; a blocked or missing vibration API is not an error.
  }
}

let inputLimitHapticsInstalled = false;

/**
 * App-wide: a `thud` whenever typing is blocked because a field reached its
 * `maxLength`, so every length-limited input gets the same feedback without
 * per-field code.
 */
export function installInputLimitHaptics(): void {
  if (inputLimitHapticsInstalled || typeof document === "undefined") return;
  inputLimitHapticsInstalled = true;
  document.addEventListener(
    "beforeinput",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      if (target.maxLength <= 0 || !event.inputType.startsWith("insert")) return;
      const selected = (target.selectionEnd ?? 0) - (target.selectionStart ?? 0);
      if (target.value.length - selected >= target.maxLength) haptic("thud");
    },
    { capture: true, passive: true },
  );
}
