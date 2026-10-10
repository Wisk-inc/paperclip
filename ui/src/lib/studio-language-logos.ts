/**
 * Language ids with a logo in `public/brands/languages/` (see its README for
 * sources). Others show their colored abbreviation badge.
 */
export const STUDIO_LANGUAGE_LOGOS: ReadonlySet<string> = new Set([
  "awk",
  "bash",
  "bun",
  "c",
  "clojure",
  "cpp",
  "crystal",
  "csharp",
  "d",
  "dart",
  "deno",
  "elixir",
  "emacslisp",
  "erlang",
  "express",
  "fastapi",
  "fish",
  "flask",
  "fortran",
  "fsharp",
  "fullstack-node",
  "go",
  "go-web",
  "groovy",
  "haskell",
  "html",
  "java",
  "javascript",
  "julia",
  "kotlin",
  "lua",
  "nim",
  "ocaml",
  "octave",
  "odin",
  "perl",
  "php",
  "php-web",
  "powershell",
  "prolog",
  "pwa",
  "python",
  "python-web",
  "r",
  "racket",
  "react",
  "ruby",
  "rust",
  "scala",
  "sql",
  "swift",
  "typescript",
  "v",
  "vite-react",
  "vue",
  "zig",
  "zsh",
]);

/** Black or near-black marks: shown inverted (light) in dark mode. */
export const STUDIO_DARK_LOGOS: ReadonlySet<string> = new Set(["awk", "crystal", "deno", "emacslisp", "express", "flask", "rust"]);

/** Deep-colored marks: brightened a little in dark mode so they stand out. */
export const STUDIO_DIM_LOGOS: ReadonlySet<string> = new Set(["d", "erlang", "fortran", "haskell", "pwa", "racket", "scala", "bash"]);

export function studioLanguageLogoUrl(languageId: string): string | null {
  return STUDIO_LANGUAGE_LOGOS.has(languageId) ? `/brands/languages/${languageId}.svg` : null;
}
