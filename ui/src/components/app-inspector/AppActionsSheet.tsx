import { useEffect, useId, useState } from "react";
import { Boxes, Copy, Download, FileCode2, Loader2 } from "lucide-react";
import type { InspectorDecodeOptions } from "@/api/app-inspector";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { copyTextToClipboard } from "@/lib/clipboard";
import { haptic } from "@/lib/haptics";
import { formatBytes } from "./file-kinds";

/** An app as the picker lists it: from the Automa app (name + icon) or, in a browser, its package. */
export interface PickerApp {
  package: string;
  label: string;
  versionName: string | null;
  sizeBytes: number | null;
  splitCount: number;
  system: boolean;
  updatedAt: number;
  iconUrl: string | null;
  /** Where Android keeps the base APK, and a same-origin URL serving it (Automa app only). */
  sourceDir: string | null;
  apkUrl: string | null;
}

export function AppIcon({ app, className }: { app: { iconUrl: string | null }; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!app.iconUrl || broken) {
    return (
      <span className={`flex shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground ${className ?? ""}`} aria-hidden="true">
        <Boxes className="size-1/2" />
      </span>
    );
  }
  return <img src={app.iconUrl} alt="" loading="lazy" onError={() => setBroken(true)} className={`shrink-0 rounded-xl object-contain ${className ?? ""}`} />;
}

const OPTION_ROWS: Array<{ key: keyof InspectorDecodeOptions; title: string; hint: string }> = [
  { key: "resources", title: "Resources", hint: "Manifest, layouts, strings and images as editable files" },
  { key: "sources", title: "Code as smali", hint: "classes.dex disassembled, editable and rebuilt" },
  { key: "java", title: "Code as Java", hint: "Readable Java from jadx, for reading and Claude" },
];

/**
 * Tap an app, get its actions (Apktool M's app dialog): what it is, what to
 * decompile, and Decompile; or save its APK to Downloads.
 */
export function AppActionsSheet({
  app,
  busy,
  phase,
  onDecompile,
  onExtract,
  onOpenChange,
}: {
  app: PickerApp | null;
  busy: boolean;
  phase: string | null;
  onDecompile: (app: PickerApp, options: InspectorDecodeOptions) => void;
  onExtract: ((app: PickerApp) => void) | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [options, setOptions] = useState<InspectorDecodeOptions>({ resources: true, sources: true, java: true });
  const [copied, setCopied] = useState(false);
  const id = useId();
  useEffect(() => setCopied(false), [app?.package]);
  const nothing = !options.resources && !options.sources && !options.java;

  return (
    <Sheet open={Boolean(app)} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-(--sz-85vh) gap-0 rounded-t-xl p-0 md:inset-x-auto md:left-1/2 md:w-full md:max-w-lg md:-translate-x-1/2" data-testid="inspector-app-sheet">
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden="true" />
        {app ? (
          <>
            <SheetHeader className="flex-row items-center gap-3 px-4 pt-3 pb-2 text-left">
              <AppIcon app={app} className="size-14" />
              <div className="min-w-0 flex-1">
                <SheetTitle className="truncate text-base">{app.label}</SheetTitle>
                <SheetDescription className="truncate font-mono text-xs">{app.package}</SheetDescription>
                <p className="truncate text-xs text-muted-foreground">
                  {[app.versionName ? `v${app.versionName}` : null, formatBytes(app.sizeBytes), app.system ? "System app" : null].filter(Boolean).join(" · ")}
                </p>
              </div>
            </SheetHeader>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
              {app.splitCount > 0 ? (
                <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                  Installed in {app.splitCount + 1} parts. Automa decompiles the base part; a rebuild may miss native code or screen-size resources kept in the
                  other parts.
                </p>
              ) : null}
              <section aria-labelledby={`${id}-decompile`} className="overflow-hidden rounded-xl border border-border bg-card">
                <h3 id={`${id}-decompile`} className="px-3 pt-2.5 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Decompile</h3>
                <ul className="divide-y divide-border">
                  {OPTION_ROWS.map((row) => (
                    <li key={row.key} className="flex items-center gap-3 px-3 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium" id={`${id}-${row.key}`}>{row.title}</span>
                        <span className="block text-xs text-muted-foreground">{row.hint}</span>
                      </span>
                      <ToggleSwitch
                        checked={options[row.key]}
                        onCheckedChange={(checked) => setOptions((current) => ({ ...current, [row.key]: checked }))}
                        aria-labelledby={`${id}-${row.key}`}
                        data-testid={`inspector-option-${row.key}`}
                      />
                    </li>
                  ))}
                </ul>
              </section>
              <Button className="h-11 w-full" disabled={busy || nothing} onClick={() => onDecompile(app, options)} data-testid="inspector-open">
                {busy ? <Loader2 className="animate-spin" /> : <FileCode2 />} {busy ? phase ?? "Starting…" : "Decompile"}
              </Button>
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                {onExtract && app.apkUrl ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onExtract(app)}
                    className="flex min-h-12 w-full items-center gap-3 border-b border-border px-3 text-left text-sm hover:bg-accent/60 disabled:opacity-60"
                    data-testid="inspector-extract"
                  >
                    <Download className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span className="flex-1">Save APK to Downloads</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    void copyTextToClipboard(app.package).then(() => {
                      haptic("tick");
                      setCopied(true);
                    });
                  }}
                  className="flex min-h-12 w-full items-center gap-3 px-3 text-left text-sm hover:bg-accent/60"
                >
                  <Copy className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span className="flex-1">{copied ? "Copied" : "Copy package name"}</span>
                </button>
              </div>
              <p className="text-xs text-muted-foreground">For apps you made or are authorized to analyze.</p>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
