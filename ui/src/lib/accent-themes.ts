/**
 * Accent color themes. `classic` (the default) is the neutral black-and-white look;
 * the others recolor primary actions, focus rings, and selections. Colors
 * live in index.css (`[data-accent]`), swatches in `--accent-swatch-*`.
 */
export const ACCENT_THEMES = [
  { id: "classic", label: "Black & white", swatch: ["--accent-swatch-classic", "--accent-swatch-classic-2"] },
  { id: "indigo", label: "Automa", swatch: ["--accent-swatch-indigo"] },
  { id: "ocean", label: "Ocean", swatch: ["--accent-swatch-ocean"] },
  { id: "teal", label: "Teal", swatch: ["--accent-swatch-teal"] },
  { id: "emerald", label: "Emerald", swatch: ["--accent-swatch-emerald"] },
  { id: "sunset", label: "Sunset", swatch: ["--accent-swatch-sunset"] },
  { id: "rose", label: "Rose", swatch: ["--accent-swatch-rose"] },
  { id: "grape", label: "Grape", swatch: ["--accent-swatch-grape"] },
  { id: "jamaica", label: "Jamaica", swatch: ["--accent-swatch-jamaica", "--accent-swatch-jamaica-2"] },
] as const;

export type AccentTheme = (typeof ACCENT_THEMES)[number]["id"];

export const ACCENT_STORAGE_KEY = "automa.accent";

/** The neutral black-and-white look, until someone picks a color. */
export const DEFAULT_ACCENT: AccentTheme = "classic";

export function isAccentTheme(value: unknown): value is AccentTheme {
  return typeof value === "string" && ACCENT_THEMES.some((theme) => theme.id === value);
}

export function applyAccent(accent: AccentTheme) {
  if (typeof document === "undefined") return;
  if (accent === "classic") delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = accent;
}
