import { useEffect, useMemo, useState, type FormEvent } from "react";
import { GitBranch, LoaderCircle, Search, Sparkles } from "lucide-react";
import { searchStudioLanguages, type StudioLanguageCategory, type StudioToolchainStatus } from "@paperclipai/shared";
import type { StudioCatalog, StudioCatalogLanguage } from "@/api/studio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export interface NewStudioAppInput {
  name: string;
  language: string;
  description: string | null;
  gitUrl: string | null;
}

interface NewStudioAppSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: StudioCatalog | undefined;
  onCreate: (input: NewStudioAppInput) => Promise<void>;
}

/** Whether a `#rrggbb` color is light enough to need dark text on it. */
export function isLightColor(color: string): boolean {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return false;
  const value = parseInt(match[1]!, 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.3;
}

/** A language's badge: its abbreviation on its usual brand color. */
export function LanguageBadge({ language, size = "md" }: { language: Pick<StudioCatalogLanguage, "abbr" | "color" | "name">; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md font-mono font-semibold",
        isLightColor(language.color) ? "text-studio-badge-foreground-dark" : "text-studio-badge-foreground",
        size === "md" ? "size-9 text-xs" : "size-6 text-(length:--text-micro)",
      )}
      style={{ backgroundColor: language.color }}
    >
      {language.abbr}
    </span>
  );
}

function repoNameFrom(url: string): string {
  const match = url.trim().match(/\/([^/]+?)(?:\.git)?\/?$/);
  return match?.[1]?.replace(/[-_]+/g, " ").trim() ?? "";
}

/**
 * Start a Studio app: pick one of the languages (search or browse by
 * category), name it, and optionally describe it so the AI assistant builds
 * it. Or paste a GitHub link to clone a repository.
 */
export function NewStudioAppSheet({ open, onOpenChange, catalog, onCreate }: NewStudioAppSheetProps) {
  const [mode, setMode] = useState<"new" | "git">("new");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<StudioLanguageCategory>("popular");
  const [languageId, setLanguageId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
  }, [open]);

  const toolchains = useMemo(() => new Map<string, StudioToolchainStatus>((catalog?.toolchains ?? []).map((status) => [status.languageId, status])), [catalog]);
  const languages = catalog?.languages ?? [];
  const shown = useMemo(() => {
    if (query.trim()) return searchStudioLanguages(query, languages);
    return languages.filter((language) => (category === "popular" ? language.popular : language.category === category));
  }, [languages, query, category]);
  const selected = languages.find((language) => language.id === languageId) ?? null;

  useEffect(() => {
    if (mode === "git" && !nameTouched) setName(repoNameFrom(gitUrl));
  }, [gitUrl, mode, nameTouched]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError("Give your app a name.");
    if (mode === "new" && !selected) return setError("Pick a language.");
    if (mode === "git" && !/^https:\/\//.test(gitUrl.trim())) return setError("Paste an https:// link to a Git repository.");
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        language: mode === "git" ? "auto" : selected!.id,
        description: description.trim() || null,
        gitUrl: mode === "git" ? gitUrl.trim() : null,
      });
      setQuery("");
      setLanguageId(null);
      setName("");
      setNameTouched(false);
      setDescription("");
      setGitUrl("");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Couldn't create the app");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-(--sz-85vh) gap-0 rounded-t-xl p-0 md:inset-x-auto md:left-1/2 md:w-full md:max-w-2xl md:-translate-x-1/2"
        data-testid="new-studio-app"
      >
        <SheetHeader className="border-b border-border">
          <SheetTitle>New app</SheetTitle>
          <SheetDescription>Pick a language, name it, and it boots up ready to run.</SheetDescription>
          <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="How to start">
            {(
              [
                ["new", "Start fresh"],
                ["git", "Clone from GitHub"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={mode === id}
                onClick={() => setMode(id)}
                className={cn("flex-1 rounded-md py-1.5 text-sm", mode === id ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}
              >
                {label}
              </button>
            ))}
          </div>
        </SheetHeader>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            {mode === "new" ? (
              <>
                <div className="relative shrink-0">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={`Search ${languages.length || "50+"} languages`}
                    aria-label="Search languages"
                    className="h-10 pl-9"
                  />
                </div>
                {!query.trim() ? (
                  <div className="-mx-4 flex shrink-0 gap-1.5 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Language categories">
                    {(catalog?.categories ?? []).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={category === item.id}
                        onClick={() => setCategory(item.id)}
                        className={cn(
                          "shrink-0 rounded-full border px-3 py-1 text-sm",
                          category === item.id ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent",
                        )}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                <ul className="grid shrink-0 grid-cols-1 gap-1.5 sm:grid-cols-2" aria-label="Languages" data-testid="studio-language-list">
                  {shown.map((language) => {
                    const toolchain = toolchains.get(language.id);
                    return (
                      <li key={language.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setLanguageId(language.id);
                            setError(null);
                          }}
                          aria-pressed={languageId === language.id}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-lg border p-2 text-left",
                            languageId === language.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-accent/50",
                          )}
                          data-testid={`studio-language-${language.id}`}
                        >
                          <LanguageBadge language={language} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{language.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {toolchain && !toolchain.available && toolchain.requires ? `Needs ${toolchain.requires} · ` : ""}
                              {language.blurb}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {shown.length === 0 ? <li className="col-span-full py-6 text-center text-sm text-muted-foreground">No language matches “{query}”.</li> : null}
                </ul>
              </>
            ) : (
              <div className="flex shrink-0 flex-col gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Repository link</span>
                  <div className="relative">
                    <GitBranch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={gitUrl}
                      onChange={(event) => setGitUrl(event.target.value)}
                      placeholder="https://github.com/owner/repo"
                      inputMode="url"
                      autoCapitalize="off"
                      autoCorrect="off"
                      aria-label="Repository link"
                      className="h-10 pl-9 font-mono text-sm"
                    />
                  </div>
                </label>
                <p className="text-xs text-muted-foreground">Public repositories clone as they are. Automa works out the language and how to run it; the assistant can help set it up and fix what's broken.</p>
              </div>
            )}

            <label className="flex shrink-0 flex-col gap-1">
              <span className="text-sm font-medium">App name</span>
              <Input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameTouched(true);
                }}
                placeholder={mode === "git" ? "Name for your copy" : "e.g. Recipe box"}
                aria-label="App name"
                maxLength={80}
                className="h-10"
              />
            </label>
            <label className="flex shrink-0 flex-col gap-1">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Sparkles className="size-3.5 text-primary" /> {mode === "git" ? "What should the assistant do? (optional)" : "Describe it for the AI (optional)"}
              </span>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                placeholder={mode === "git" ? "Set it up and fix anything that doesn't run" : "A recipe app with a search box and a database of my favorite meals"}
                aria-label="Describe the app"
                className="text-sm"
              />
              <span className="text-xs text-muted-foreground">The AI assistant (with your own API key) builds the UI, the logic, and the database from this.</span>
            </label>
          </div>

          <div className="flex items-center gap-2 border-t border-border p-3 pb-(--sz-calc-8) md:pb-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <p className="min-w-0 flex-1 truncate text-right text-sm text-destructive" role="alert">
              {error}
            </p>
            <Button type="submit" disabled={busy} data-testid="studio-create-app">
              {busy ? <LoaderCircle className="animate-spin" /> : null}
              {mode === "git" ? "Clone app" : "Create app"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
