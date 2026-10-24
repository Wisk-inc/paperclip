import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Boxes,
  Check,
  ChevronRight,
  Coffee,
  Download,
  FileCode2,
  Hammer,
  Info,
  Loader2,
  Search,
  ShieldAlert,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  appInspectorApi,
  type InspectorAppInfo,
  type InspectorFileNode,
  type InspectorProjectView,
  type InspectorView,
} from "@/api/app-inspector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { fileKind, formatBytes } from "./file-kinds";
import { InspectorEditor } from "./InspectorEditor";

type Tab = "files" | "java" | "info";

/** jadx's "progress: 951 of 1745" as a fraction, while it decompiles. */
function javaProgress(log: string): number | null {
  const matches = [...log.matchAll(/progress: (\d+) of (\d+)/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const total = Number(last[2]);
  return total > 0 ? Number(last[1]) / total : null;
}

/** The last line a tool printed (jadx redraws its progress with \r). */
function currentActivity(log: string): string {
  const lines = log.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "").replace(/^==>\s*/, "").replace(/^(I:|INFO\s+-)\s*/, "").slice(0, 160);
}

/** The log as a terminal shows it: \r-redrawn progress collapses to its last state. */
function readableLog(log: string): string {
  return log
    .split("\n")
    .map((line) => line.split("\r").filter(Boolean).pop() ?? "")
    // The JVM echoes JAVA_TOOL_OPTIONS (proxy settings and the like) on every start.
    .filter((line) => !/^Picked up (JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)/.test(line))
    .join("\n");
}

/** Apktool M's progress window: what is running, how far along, and the live log. */
function JobWindow({ project }: { project: InspectorProjectView }) {
  const [open, setOpen] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);
  const working = project.status === "decoding" || project.status === "building" || project.java === "working";
  const failed = project.status === "failed" || project.java === "failed";
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [project.logTail, open]);
  if (!working && !failed) return null;

  const title =
    project.status === "decoding"
      ? "Decompiling"
      : project.status === "building"
        ? "Building the APK"
        : project.java === "working"
          ? "Decompiling to Java"
          : "Didn't finish";
  const steps: Array<{ label: string; state: "done" | "active" | "waiting" | "failed" }> = [
    {
      label: "apktool: manifest, resources, smali",
      state: project.decoded ? "done" : project.status === "decoding" ? "active" : project.status === "failed" ? "failed" : "waiting",
    },
  ];
  if (project.options.java) {
    steps.push({
      label: "jadx: code as Java",
      state: project.java === "ready" ? "done" : project.java === "working" ? "active" : project.java === "failed" ? "failed" : "waiting",
    });
  }
  if (project.status === "building") steps.push({ label: "apktool build, align, sign", state: "active" });
  const progress = project.status !== "decoding" && project.status !== "building" && project.java === "working" ? javaProgress(project.logTail) : null;

  return (
    <section className="flex flex-col gap-2 border-b border-border bg-card px-3 py-2" aria-label="Progress" data-testid="inspector-job">
      <div className="flex items-center gap-2">
        {working ? <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" /> : <ShieldAlert className="size-4 text-destructive" aria-hidden="true" />}
        <span className="flex-1 text-sm font-semibold">{title}{progress !== null ? ` · ${Math.round(progress * 100)}%` : ""}</span>
        <Button variant="ghost" size="sm" onClick={() => setOpen((value) => !value)} data-testid="inspector-log-toggle">
          <TerminalSquare /> {open ? "Hide log" : "Log"}
        </Button>
      </div>
      {working ? <ProgressBar label={title} value={progress} /> : null}
      <ol className="flex flex-wrap gap-x-4 gap-y-1" data-testid="inspector-steps">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-1.5 text-xs">
            {step.state === "done" ? (
              <Check className="size-3.5 text-primary" aria-hidden="true" />
            ) : step.state === "active" ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
            ) : (
              <span className={cn("size-3.5 rounded-full border", step.state === "failed" ? "border-destructive" : "border-border")} aria-hidden="true" />
            )}
            <span className={cn(step.state === "waiting" && "text-muted-foreground", step.state === "failed" && "text-destructive")}>{step.label}</span>
          </li>
        ))}
      </ol>
      {project.error ? <p className="text-xs text-destructive">{project.error}</p> : null}
      {open ? (
        <pre
          ref={logRef}
          className="max-h-(--sz-28dvh) overflow-auto rounded-lg bg-(--terminal-surface) px-2 py-1.5 font-mono text-(length:--text-micro) whitespace-pre-wrap text-foreground"
          data-testid="inspector-log"
        >
          {readableLog(project.logTail) || (working ? "Starting…" : "The log starts fresh when Automa restarts.")}
        </pre>
      ) : (
        <p className="truncate font-mono text-xs text-muted-foreground" data-testid="inspector-activity">{currentActivity(project.logTail) || "Starting…"}</p>
      )}
    </section>
  );
}

function Breadcrumbs({ root, path, onNavigate }: { root: string; path: string; onNavigate: (path: string) => void }) {
  const parts = path.split("/").filter(Boolean);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [path]);
  return (
    <div ref={scroller} className="flex items-center gap-0.5 overflow-x-auto px-2 py-1 text-xs whitespace-nowrap" aria-label="Folder path" data-testid="inspector-breadcrumbs">
      <button type="button" className={cn("rounded px-1.5 py-1 font-medium", parts.length ? "text-muted-foreground hover:text-foreground" : "text-foreground")} onClick={() => onNavigate("")}>
        {root}
      </button>
      {parts.map((part, index) => (
        <span key={`${index}-${part}`} className="flex items-center gap-0.5">
          <ChevronRight className="size-3 text-muted-foreground" aria-hidden="true" />
          <button
            type="button"
            className={cn("rounded px-1.5 py-1 font-mono", index === parts.length - 1 ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
            onClick={() => onNavigate(parts.slice(0, index + 1).join("/"))}
          >
            {part}
          </button>
        </span>
      ))}
    </div>
  );
}

function FileRow({
  companyId,
  projectId,
  view,
  name,
  path,
  dir,
  detail,
  onOpen,
}: {
  companyId: string;
  projectId: string;
  view: InspectorView;
  name: string;
  path: string;
  dir: boolean;
  detail: string;
  onOpen: () => void;
}) {
  const kind = fileKind(name, dir);
  return (
    <li>
      <button type="button" className="flex min-h-12 w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-accent/60" onClick={onOpen} data-testid="inspector-row" data-path={path}>
        {kind.image ? (
          <img
            src={appInspectorApi.imageUrl(companyId, projectId, view, path)}
            alt=""
            loading="lazy"
            className="size-8 shrink-0 rounded bg-muted object-contain"
          />
        ) : (
          <kind.icon className={cn("size-6 shrink-0", kind.tone)} aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-sm">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">{detail}</span>
        </span>
        {dir ? <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" /> : null}
      </button>
    </li>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function InfoList({ title, items }: { title: string; items: string[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const shown = open ? items : items.slice(0, 4);
  return (
    <section className="rounded-xl border border-border bg-card">
      <h3 className="flex items-center justify-between px-3 pt-2.5 text-sm font-semibold">
        {title}
        <span className="rounded-full bg-muted px-2 text-xs font-normal text-muted-foreground">{items.length}</span>
      </h3>
      <ul className="px-3 pt-1 pb-2">
        {shown.map((item) => (
          <li key={item} className="truncate py-0.5 font-mono text-xs text-muted-foreground">{item}</li>
        ))}
      </ul>
      {items.length > 4 ? (
        <button type="button" className="w-full border-t border-border py-2 text-xs font-medium text-primary" onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : `Show all ${items.length}`}
        </button>
      ) : null}
    </section>
  );
}

function AppInfoPanel({ companyId, projectId, info, iconUrl }: { companyId: string; projectId: string; info: InspectorAppInfo; iconUrl: string | null }) {
  const stats: Array<[string, string | null]> = [
    ["Version", info.versionName ? `${info.versionName}${info.versionCode ? ` (${info.versionCode})` : ""}` : null],
    ["Min SDK", info.minSdk],
    ["Target SDK", info.targetSdk],
    ["Debuggable", info.debuggable ? "Yes" : "No"],
  ];
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="inspector-info">
      <section className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
        {iconUrl || info.iconPath ? (
          <img src={iconUrl ?? appInspectorApi.imageUrl(companyId, projectId, "files", info.iconPath!)} alt="" className="size-14 rounded-xl object-contain" />
        ) : (
          <span className="flex size-14 items-center justify-center rounded-xl bg-muted" aria-hidden="true"><Boxes className="size-7 text-muted-foreground" /></span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-semibold">{info.label ?? info.packageName ?? "App"}</span>
          <span className="block truncate font-mono text-xs text-muted-foreground">{info.packageName}</span>
        </span>
      </section>
      <dl className="grid grid-cols-2 gap-2">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-muted px-3 py-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate text-sm font-semibold">{value ?? "—"}</dd>
          </div>
        ))}
      </dl>
      {info.launcherActivity ? (
        <div className="rounded-lg bg-muted px-3 py-2">
          <p className="text-xs text-muted-foreground">Opens with</p>
          <p className="truncate font-mono text-xs">{info.launcherActivity}</p>
        </div>
      ) : null}
      <InfoList title="Permissions" items={info.permissions} />
      <InfoList title="Activities" items={info.activities} />
      <InfoList title="Services" items={info.services} />
      <InfoList title="Receivers" items={info.receivers} />
      <InfoList title="Providers" items={info.providers} />
    </div>
  );
}

/**
 * One decoded app, full screen, the way Apktool M opens a project: an app bar
 * with Build, the decompile log while it works, then a file manager (Files,
 * Java, Info) with breadcrumbs, typed icons, image thumbnails and search, and a
 * full-screen editor for any file.
 */
export function ProjectExplorer({ companyId, projectId, iconUrl, onClose }: { companyId: string; projectId: string; iconUrl: string | null; onClose: () => void }) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const [tab, setTab] = useState<Tab>("files");
  const [cwd, setCwd] = useState<Record<InspectorView, string>>({ files: "", java: "" });
  const [openFile, setOpenFile] = useState<{ view: InspectorView; path: string } | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"name" | "text">("name");
  const debouncedQuery = useDebounced(query.trim(), 350);

  const project = useQuery({
    queryKey: ["inspector", "project", companyId, projectId],
    queryFn: () => appInspectorApi.project(companyId, projectId).then((r) => r.project),
    refetchInterval: (q) => {
      const data = q.state.data;
      return data && (data.status === "decoding" || data.status === "building" || data.java === "working") ? 1200 : false;
    },
  });
  const p = project.data;
  const view: InspectorView = tab === "java" ? "java" : "files";
  const viewReady = tab === "info" ? Boolean(p?.decoded) : view === "files" ? Boolean(p?.decoded) : p?.java === "ready";

  const info = useQuery({
    queryKey: ["inspector", "info", companyId, projectId],
    queryFn: () => appInspectorApi.info(companyId, projectId).then((r) => r.info),
    enabled: Boolean(p?.decoded),
    staleTime: 60_000,
  });
  const dir = useQuery({
    queryKey: ["inspector", "dir", companyId, projectId, view, cwd[view]],
    queryFn: () => appInspectorApi.dir(companyId, projectId, cwd[view], view).then((r) => r.entries),
    enabled: viewReady && tab !== "info" && !debouncedQuery,
  });
  const search = useQuery({
    queryKey: ["inspector", "search", companyId, projectId, view, mode, debouncedQuery],
    queryFn: () => appInspectorApi.search(companyId, projectId, view, debouncedQuery, mode),
    enabled: viewReady && tab !== "info" && debouncedQuery.length >= (mode === "text" ? 2 : 1),
  });

  const build = useMutation({
    mutationFn: () => appInspectorApi.rebuild(companyId, projectId),
    onSuccess: ({ project: next }) => {
      haptic("tick");
      client.setQueryData(["inspector", "project", companyId, projectId], next);
    },
    onError: (error) => pushToast({ title: "Couldn't build", body: error instanceof Error ? error.message : String(error), tone: "error" }),
  });

  const entries = useMemo(() => dir.data ?? [], [dir.data]);
  const counts = useMemo(() => {
    const folders = entries.filter((entry) => entry.dir).length;
    return `${folders} folder${folders === 1 ? "" : "s"} · ${entries.length - folders} file${entries.length - folders === 1 ? "" : "s"}`;
  }, [entries]);
  const appIcon = iconUrl ?? (info.data?.iconPath ? appInspectorApi.imageUrl(companyId, projectId, "files", info.data.iconPath) : null);
  const busy = p?.status === "decoding" || p?.status === "building";

  const openEntry = (entry: { path: string; dir: boolean }) => {
    haptic("tick");
    if (entry.dir) {
      setCwd((current) => ({ ...current, [view]: entry.path }));
      setQuery("");
    } else {
      setOpenFile({ view, path: entry.path });
    }
  };

  return (
    <div className="studio-ide-immersive fixed inset-0 z-40 flex flex-col bg-background pt-(--sz-safe-top) pb-(--sz-safe-bottom)" data-testid="inspector-project-view">
      <header className="flex items-center gap-2 border-b border-border px-1 py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="Back to apps" onClick={onClose}><ArrowLeft /></Button>
        {appIcon ? (
          <img src={appIcon} alt="" className="size-8 shrink-0 rounded-lg object-contain" />
        ) : (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted" aria-hidden="true"><Boxes className="size-4 text-muted-foreground" /></span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{info.data?.label ?? p?.label ?? "Loading…"}</span>
          <span className="block truncate font-mono text-xs text-muted-foreground">
            {[info.data?.packageName ?? p?.packageName, info.data?.versionName].filter(Boolean).join(" · ")}
          </span>
        </span>
        {p?.decoded ? (
          <Button size="sm" disabled={build.isPending || busy} onClick={() => build.mutate()} data-testid="inspector-rebuild">
            {p.status === "building" ? <Loader2 className="animate-spin" /> : <Hammer />} Build
          </Button>
        ) : null}
      </header>

      {p ? <JobWindow project={p} /> : null}

      {p?.hasOutput ? (
        <section className="flex items-center gap-3 border-b border-border bg-card px-3 py-2" data-testid="inspector-output">
          <Check className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Built and signed</span>
            <span className="block truncate text-xs text-muted-foreground">
              {p.downloadsPath ? `In Downloads as ${p.downloadsPath.split("/").pop()}. ` : ""}Signed with your own key: uninstall the original first.
            </span>
          </span>
          <Button asChild size="sm" variant={p.downloadsPath ? "outline" : "default"}>
            <a href={appInspectorApi.outputUrl(companyId, projectId)} download={p.outputName ?? undefined} data-testid="inspector-save-download">
              <Download /> {p.downloadsPath ? "Copy" : "Save"}
            </a>
          </Button>
        </section>
      ) : null}

      {p && (p.decoded || p.java !== "none") ? (
        <div className="grid grid-cols-3 border-b border-border" role="tablist" aria-label="What to browse">
          {(
            [
              { id: "files" as const, label: "Files", icon: FileCode2 },
              { id: "java" as const, label: "Java", icon: Coffee },
              { id: "info" as const, label: "Info", icon: Info },
            ]
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => {
                haptic("tick");
                setTab(item.id);
                setQuery("");
              }}
              className={cn(
                "flex min-h-11 items-center justify-center gap-1.5 border-b-2 text-sm transition-colors",
                tab === item.id ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              data-testid={`inspector-view-${item.id}`}
            >
              <item.icon className="size-4" aria-hidden="true" />
              {item.label}
              {item.id === "java" && p.java === "working" ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {tab === "info" ? (
          info.isPending ? (
            <div className="flex flex-col gap-2 p-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
          ) : info.isError || !info.data ? (
            <p className="p-4 text-sm text-muted-foreground">{info.error instanceof Error ? info.error.message : "No manifest to read yet."}</p>
          ) : (
            <AppInfoPanel companyId={companyId} projectId={projectId} info={info.data} iconUrl={appIcon} />
          )
        ) : !viewReady ? (
          p?.status === "decoding" ? (
            <p className="p-6 text-center text-sm text-muted-foreground">The app's files appear here as soon as apktool finishes.</p>
          ) : p && !busy ? (
            <p className="p-4 text-sm text-muted-foreground">
              {view === "java"
                ? p.java === "working"
                  ? "Decompiling to Java… big apps take a few minutes on a phone."
                  : p.java === "failed"
                    ? "jadx couldn't decompile this app. The smali in Files is the code apktool decoded."
                    : "Java wasn't chosen when this app was decompiled."
                : "This app wasn't decoded. Check the log above."}
            </p>
          ) : null
        ) : (
          <>
            <div className="sticky top-0 z-10 border-b border-border bg-background">
              <div className="flex items-center gap-2 px-2 pt-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={mode === "name" ? "Find files by name" : "Find text in files"}
                    aria-label="Search this app"
                    className="h-9 pr-8 pl-8 text-sm"
                    data-testid="inspector-file-search"
                  />
                  {query ? (
                    <button type="button" aria-label="Clear the search" className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground" onClick={() => setQuery("")}>
                      <X className="size-4" />
                    </button>
                  ) : null}
                </div>
                <div className="flex rounded-lg bg-muted p-0.5" role="radiogroup" aria-label="Search in">
                  {(["name", "text"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={mode === value}
                      onClick={() => setMode(value)}
                      className={cn("h-8 rounded-md px-2.5 text-xs", mode === value ? "bg-background font-semibold text-foreground shadow-sm" : "text-muted-foreground")}
                      data-testid={`inspector-search-${value}`}
                    >
                      {value === "name" ? "Names" : "Text"}
                    </button>
                  ))}
                </div>
              </div>
              {debouncedQuery ? (
                <p className="px-3 py-1.5 text-xs text-muted-foreground">
                  {search.isFetching
                    ? "Searching…"
                    : search.data
                      ? `${search.data.results.length}${search.data.truncated ? "+" : ""} result${search.data.results.length === 1 ? "" : "s"}`
                      : ""}
                </p>
              ) : (
                <Breadcrumbs root={view === "java" ? "java" : "app"} path={cwd[view]} onNavigate={(path) => setCwd((current) => ({ ...current, [view]: path }))} />
              )}
            </div>

            {debouncedQuery ? (
              <ul className="divide-y divide-border" data-testid="inspector-results">
                {(search.data?.results ?? []).map((hit) => (
                  <FileRow
                    key={`${hit.path}:${hit.line ?? ""}`}
                    companyId={companyId}
                    projectId={projectId}
                    view={view}
                    name={hit.path.split("/").pop() ?? hit.path}
                    path={hit.path}
                    dir={hit.dir}
                    detail={hit.preview ? `${hit.line}: ${hit.preview}` : hit.path}
                    onOpen={() => openEntry(hit)}
                  />
                ))}
                {search.data && search.data.results.length === 0 ? <li className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing found.</li> : null}
              </ul>
            ) : dir.isPending ? (
              <div className="flex flex-col gap-1.5 p-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
            ) : dir.isError ? (
              <p className="p-4 text-sm text-destructive">{dir.error instanceof Error ? dir.error.message : "Couldn't read that folder"}</p>
            ) : (
              <>
                <ul className="divide-y divide-border" data-testid="inspector-tree">
                  {entries.map((entry: InspectorFileNode) => (
                    <FileRow
                      key={entry.path}
                      companyId={companyId}
                      projectId={projectId}
                      view={view}
                      name={entry.name}
                      path={entry.path}
                      dir={entry.dir}
                      detail={entry.dir ? fileKind(entry.name, true).label : [fileKind(entry.name, false).label, formatBytes(entry.size)].filter(Boolean).join(" · ")}
                      onOpen={() => openEntry(entry)}
                    />
                  ))}
                  {entries.length === 0 ? <li className="px-4 py-6 text-center text-sm text-muted-foreground">Empty folder.</li> : null}
                </ul>
                {entries.length > 0 ? <p className="px-3 py-2 text-xs text-muted-foreground">{counts}</p> : null}
              </>
            )}
          </>
        )}
      </div>

      {openFile ? (
        <InspectorEditor
          companyId={companyId}
          projectId={projectId}
          view={openFile.view}
          path={openFile.path}
          building={p?.status === "building"}
          onClose={() => setOpenFile(null)}
        />
      ) : null}
    </div>
  );
}
