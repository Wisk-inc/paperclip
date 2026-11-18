import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import {
  APP_LANGUAGE_AUTO,
  APP_LANGUAGES,
  appLanguage,
  type AppLanguage,
  type AppLanguageCode,
  type AppLanguagePreference,
} from "@paperclipai/shared";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useLanguage } from "@/context/LanguageContext";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/** Intl's names for the two Chinese scripts read better than "Chinese (China)". */
const DISPLAY_CODE: Partial<Record<AppLanguageCode, string>> = { "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" };

/** A language's name in the language the screens are in ("alemán" for German, in Spanish). */
export function languageNameIn(code: AppLanguageCode, inLanguage: AppLanguageCode): string {
  try {
    const name = new Intl.DisplayNames([inLanguage], { type: "language" }).of(DISPLAY_CODE[code] ?? code);
    if (name && name !== code) return name;
  } catch {
    // An older browser without display names: the English name.
  }
  return appLanguage(code).name;
}

/** A country's name in the language the screens are in, or null. */
export function countryNameIn(country: string | null, inLanguage: AppLanguageCode): string | null {
  if (!country) return null;
  try {
    const name = new Intl.DisplayNames([inLanguage], { type: "region" }).of(country);
    if (name && name !== country) return name;
  } catch {
    // An older browser: the two letters.
  }
  return country;
}

function folded(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function matches(language: AppLanguage, localName: string, query: string): boolean {
  if (!query) return true;
  const wanted = folded(query.trim());
  return [language.nativeName, language.name, localName, language.code].some((name) => folded(name).includes(wanted));
}

/** The language a choice shows as: "Español", or for Auto "Español (México)" with where the device is. */
export function preferenceLabel(
  preference: AppLanguagePreference,
  detected: { language: AppLanguageCode; country: string | null },
): string {
  if (preference !== APP_LANGUAGE_AUTO) return appLanguage(preference).nativeName;
  const name = appLanguage(detected.language).nativeName;
  const country = countryNameIn(detected.country, detected.language);
  return country ? `${name} (${country})` : name;
}

function LanguageOption({
  selected,
  onSelect,
  title,
  subtitle,
  titleIsName,
  testId,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  subtitle: string | null;
  /** The title is a language's own name: never translated. */
  titleIsName: boolean;
  testId: string;
}) {
  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className={cn(
          "flex min-h-12 w-full items-center gap-3 px-3 py-2 text-start transition-colors hover:bg-accent/60 active:bg-accent",
          selected && "bg-accent/40",
        )}
        data-testid={testId}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground" translate={titleIsName ? "no" : undefined}>
            {title}
          </span>
          {subtitle ? (
            <span className="block truncate text-xs text-muted-foreground" translate={titleIsName ? "no" : undefined}>
              {subtitle}
            </span>
          ) : null}
        </span>
        {selected ? <Check className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
      </button>
    </li>
  );
}

/**
 * Automa's language: Auto (what this phone or browser asks for, and where it
 * is) or one of the 40 languages. Changes apply at once, are kept on this
 * device and saved to the account, and agents write to the person in it.
 */
export function LanguageSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { preference, language, detected, setPreference, unsynced, aiTranslation } = useLanguage();
  const [query, setQuery] = useState("");
  const localNames = useMemo(
    () => new Map(APP_LANGUAGES.map((option) => [option.code, languageNameIn(option.code, language)] as const)),
    [language],
  );
  const shown = APP_LANGUAGES.filter((option) => matches(option, localNames.get(option.code) ?? option.name, query));
  const autoShown = !query.trim() || folded("auto").includes(folded(query.trim()));
  const deviceLabel = preferenceLabel(APP_LANGUAGE_AUTO, detected);

  const choose = (next: AppLanguagePreference) => {
    haptic("tick");
    setPreference(next);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
    >
      <SheetContent side="bottom" className="flex max-h-(--sz-calc-18) flex-col gap-0 p-0" data-testid="language-sheet">
        <SheetHeader className="px-4 pt-4 pb-3 text-start">
          <SheetTitle>Language</SheetTitle>
          <SheetDescription>Automa’s screens, and the language your agents write to you in.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-3">
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search languages"
              aria-label="Search languages"
              className="ps-9"
              data-testid="language-search"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pb-6">
          <ul role="radiogroup" aria-label="Language" className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {autoShown ? (
              <LanguageOption
                selected={preference === APP_LANGUAGE_AUTO}
                onSelect={() => choose(APP_LANGUAGE_AUTO)}
                title="Auto"
                subtitle={`Follows this device: ${deviceLabel}`}
                titleIsName={false}
                testId="language-option-auto"
              />
            ) : null}
            {shown.map((option) => {
              const localName = localNames.get(option.code) ?? option.name;
              return (
                <LanguageOption
                  key={option.code}
                  selected={preference === option.code}
                  onSelect={() => choose(option.code)}
                  title={option.nativeName}
                  subtitle={localName !== option.nativeName ? localName : null}
                  titleIsName
                  testId={`language-option-${option.code}`}
                />
              );
            })}
          </ul>
          {shown.length === 0 && !autoShown ? (
            <p className="px-1 text-sm text-muted-foreground" data-testid="language-none">No language matches that search.</p>
          ) : null}
          <p className="px-1 text-xs text-muted-foreground">
            {aiTranslation
              ? "Screens Automa hasn’t translated yet are translated by its free AI models the first time they open, then remembered. Only Automa’s own words are sent, never your chats, tasks or names."
              : language !== "en"
                ? "The main screens are translated. Sign in and the rest of Automa is translated too."
                : "Auto uses your phone’s or browser’s language. Agents write to you in the language you pick."}
          </p>
          {unsynced ? (
            <p className="px-1 text-xs text-muted-foreground" data-testid="language-unsynced">
              Saved on this device. Your account gets it the next time you’re signed in and online.
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
