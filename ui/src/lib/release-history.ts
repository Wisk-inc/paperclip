/** One Automa release: its version, the day it came out, and what it brought. */
export interface AutomaRelease {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  highlights: string;
}

/** Newest first. The first Android app came out on 27 September 2026. */
export const AUTOMA_RELEASES: AutomaRelease[] = [
  { version: "1.8.4", date: "2026-10-26", highlights: "Free models in chat, no key needed: 19 chat models that stream their replies, think at a chosen depth, search and read the web, work with files and commands, message teammates and manage tasks, use your connected apps, and draw with a paired image model (the two makers' logos kiss to show the bond). Image models draw from a description or redraw an attached photo; pictures load with a shimmer and save to the phone. Source links show the site's favicon. Thinking is a dropdown you can open and close on every model. Message actions sit on the newest reply; press and hold any message for its menu. Home and Costs show what free models saved, with a reset" },
  { version: "1.8.3", date: "2026-10-26", highlights: "Updating the server in Termux now restarts it, so the update takes effect at once. Ask Claude waits for your sign-in, keeps what you had typed, and skips offboarded agents. The first update uses the command from the setup screen; automa update works from then on" },
  { version: "1.8.2", date: "2026-10-26", highlights: "When the Automa server on your phone is older than the app, Terminals and the App Inspector say so and offer the update (instead of \"API route not found\"); automa update in Termux installs it. Ask Claude about any app: from the app list or a decoded project, a chat opens with the question ready" },
  { version: "1.8.1", date: "2026-10-24", highlights: "Fixes \"Organization not found\" on Terminals, App Inspector and every tab after them; a one-tap fix when Termux blocks Automa from starting, instead of repeated Termux error reports" },
  { version: "1.8.0", date: "2026-10-24", highlights: "Terminals: run Claude Code, Codex and more on the device in their full terminal UI. App Inspector: pick an app on your phone, read its code as Java with Claude, edit and rebuild. Your API balance in your profile" },
  { version: "1.7.0", date: "2026-10-24", highlights: "Anthropic API agents with Claude Code's tools on phones, thinking modes, Gemini 4 Argon and Kimi K3.1 Pro, start-up progress, balances and a spending limit" },
  { version: "1.6.1", date: "2026-10-24", highlights: "Bug fixes across chat, Studio, keys and the phone app; the bell clears when tapped" },
  { version: "1.6.0", date: "2026-10-22", highlights: "Live replies and visible thinking, token and cost counts everywhere, a faster Studio" },
  { version: "1.5.0", date: "2026-10-21", highlights: "Slash commands in chat, app shortcuts, an offline sheet, and the app remembers where you were" },
  { version: "1.4.2", date: "2026-10-10", highlights: "Smoother scrolling, full-screen App Studio, one API keys page, and a feature tour" },
  { version: "1.4.1", date: "2026-10-10", highlights: "The app locked to its own Automa on the phone, and a wireless ADB wizard" },
  { version: "1.4.0", date: "2026-10-10", highlights: "App Studio: build and run apps with an AI assistant, checkpoints and sharing" },
  { version: "1.3.0", date: "2026-09-29", highlights: "Profile and organization sheet, drag-to-connect org chart, run Automa on the phone" },
  { version: "1.2.0", date: "2026-09-28", highlights: "The org chart on phones and one model switch in chat" },
  { version: "1.1.0", date: "2026-09-28", highlights: "Continue with Google and push notifications" },
  { version: "1.0.0", date: "2026-09-27", highlights: "The first Automa for Android" },
];

/** A date or time as people read it ("24 Oct 2026"), or null when it isn't one. */
export function formatReleaseDate(value: string | undefined | null, withTime = false): string | null {
  if (!value) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

/** When this board was built (set by Vite); null in tests and dev. */
export function boardBuildTime(): string | null {
  return typeof __AUTOMA_BUILD_TIME__ === "string" ? __AUTOMA_BUILD_TIME__ : null;
}
