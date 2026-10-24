import { CalendarDays, Hammer, Smartphone } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { automaNative, isAutomaApp } from "@/lib/automa-native";
import { AUTOMA_RELEASES, boardBuildTime, formatReleaseDate } from "@/lib/release-history";

/**
 * About Automa: this version and when it was built, and every release with
 * the day it came out.
 */
export function AboutAutomaSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const info = isAutomaApp() ? automaNative.info() : null;
  const appVersion = info?.appVersion ?? null;
  const appBuilt = formatReleaseDate(info?.buildTime, true);
  const boardBuilt = formatReleaseDate(boardBuildTime(), true);
  const first = AUTOMA_RELEASES.at(-1)!;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex max-h-(--sz-calc-18) flex-col gap-0 p-0" data-testid="about-automa">
        <SheetHeader className="px-4 pt-4 pb-3 text-left">
          <SheetTitle>About Automa</SheetTitle>
          <SheetDescription>By Corx Labs · Made in Jamaica 🇯🇲</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 pb-6">
          <dl className="grid gap-2 rounded-xl border border-border bg-card p-3 text-sm">
            {appVersion ? (
              <div className="flex items-center gap-2">
                <Smartphone className="size-4 text-muted-foreground" aria-hidden="true" />
                <dt className="text-muted-foreground">App</dt>
                <dd className="ml-auto text-right font-medium" data-testid="about-app-version">
                  {appVersion}
                  {appBuilt ? <span className="block text-xs font-normal text-muted-foreground">built {appBuilt}</span> : null}
                </dd>
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <Hammer className="size-4 text-muted-foreground" aria-hidden="true" />
              <dt className="text-muted-foreground">This version</dt>
              <dd className="ml-auto text-right font-medium" data-testid="about-board-build">
                {AUTOMA_RELEASES[0]!.version}
                <span className="block text-xs font-normal text-muted-foreground">
                  {boardBuilt ? `built ${boardBuilt}` : `released ${formatReleaseDate(AUTOMA_RELEASES[0]!.date)}`}
                </span>
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <CalendarDays className="size-4 text-muted-foreground" aria-hidden="true" />
              <dt className="text-muted-foreground">First released</dt>
              <dd className="ml-auto font-medium">{formatReleaseDate(first.date)}</dd>
            </div>
          </dl>

          <section aria-label="Version history" className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Version history</h3>
            <ol className="flex flex-col">
              {AUTOMA_RELEASES.map((release) => (
                <li key={release.version} className="flex gap-3 border-l-2 border-border py-2 pl-3" data-testid="about-release">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-2 text-sm">
                      <span className="font-semibold">{release.version}</span>
                      <span className="text-xs text-muted-foreground">{formatReleaseDate(release.date)}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{release.highlights}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
