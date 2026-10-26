import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, FileUp, FolderOpen, LayoutGrid, Loader2, Search, Trash2, X } from "lucide-react";
import { appInspectorApi, type InspectorDecodeOptions, type InspectorProjectView } from "@/api/app-inspector";
import { AppActionsSheet, AppIcon, type PickerApp } from "@/components/app-inspector/AppActionsSheet";
import { formatBytes } from "@/components/app-inspector/file-kinds";
import { ProjectExplorer } from "@/components/app-inspector/ProjectExplorer";
import { Mascot } from "@/components/mascot/Mascot";
import { isServerTooOld, PhoneServerOutdated } from "@/components/device/PhoneServerOutdated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { useAskClaude } from "@/hooks/useAskClaude";
import { automaNative } from "@/lib/automa-native";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

type HomeTab = "apps" | "projects";
type Sort = "name" | "size" | "updated";

function projectStatus(project: InspectorProjectView): { text: string; tone: string } {
  if (project.status === "decoding") return { text: "Decompiling…", tone: "bg-primary/10 text-primary" };
  if (project.status === "building") return { text: "Building…", tone: "bg-primary/10 text-primary" };
  if (project.status === "built") return { text: "Built", tone: "bg-primary/10 text-primary" };
  if (project.status === "failed" && !project.decoded) return { text: "Failed", tone: "bg-destructive/10 text-destructive" };
  if (project.status === "failed") return { text: "Build failed", tone: "bg-destructive/10 text-destructive" };
  if (project.java === "working") return { text: "Java…", tone: "bg-muted text-muted-foreground" };
  return { text: "Ready", tone: "bg-muted text-muted-foreground" };
}

/**
 * App Inspector, laid out like Apktool M: the phone's apps (tap one for its
 * actions: decompile with options, or save its APK), decompiled projects, and
 * a full-screen project with a file manager, Java, app info, a live log and a
 * code editor. Decoding uses apktool, Java uses jadx, and Build signs the APK.
 * For apps you made or are authorized to analyze.
 */
export function AppInspector() {
  const { selectedCompanyId: companyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const client = useQueryClient();
  const [tab, setTab] = useState<HomeTab>("apps");
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [sheetApp, setSheetApp] = useState<PickerApp | null>(null);
  const [search, setSearch] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [sort, setSort] = useState<Sort>("name");
  const [phase, setPhase] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const askClaude = useAskClaude(companyId);

  useEffect(() => setBreadcrumbs([{ label: "App Inspector" }]), [setBreadcrumbs]);

  const status = useQuery({
    queryKey: ["inspector", "status", companyId],
    queryFn: () => appInspectorApi.status(companyId!),
    enabled: Boolean(companyId),
  });
  const nativeAvailable = automaNative.canListInstalledApps();
  const nativeApps = useQuery({
    queryKey: ["inspector", "native-apps"],
    queryFn: () => automaNative.installedApps(),
    enabled: nativeAvailable,
    staleTime: 60_000,
  });
  const projects = useQuery({
    queryKey: ["inspector", "projects", companyId],
    queryFn: () => appInspectorApi.projects(companyId!).then((r) => r.projects),
    enabled: Boolean(companyId),
    refetchInterval: (query) =>
      !openProject && (query.state.data ?? []).some((p: InspectorProjectView) => p.status === "decoding" || p.status === "building" || p.java === "working")
        ? 2000
        : false,
  });

  const apps: PickerApp[] = useMemo(() => {
    if (nativeAvailable && nativeApps.data) {
      return nativeApps.data.map((app) => ({
        package: app.package,
        label: app.label,
        versionName: app.versionName,
        sizeBytes: app.sizeBytes,
        splitCount: app.splitCount,
        system: app.system,
        updatedAt: app.updatedAt,
        iconUrl: app.iconUrl,
        sourceDir: app.sourceDir,
        apkUrl: app.apkUrl,
      }));
    }
    return (status.data?.apps ?? []).map((pkg) => ({
      package: pkg,
      label: pkg.split(".").pop() || pkg,
      versionName: null,
      sizeBytes: null,
      splitCount: 0,
      system: false,
      updatedAt: 0,
      iconUrl: null,
      sourceDir: null,
      apkUrl: null,
    }));
  }, [nativeAvailable, nativeApps.data, status.data]);
  const iconByPackage = useMemo(() => new Map(apps.map((app) => [app.package, app.iconUrl])), [apps]);
  const systemCount = apps.filter((app) => app.system).length;
  const visibleApps = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = apps.filter(
      (app) => (showSystem || !app.system) && (!term || app.label.toLowerCase().includes(term) || app.package.toLowerCase().includes(term)),
    );
    const sorted = [...filtered];
    if (sort === "size") sorted.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    else if (sort === "updated") sorted.sort((a, b) => b.updatedAt - a.updatedAt);
    else sorted.sort((a, b) => a.label.localeCompare(b.label));
    return sorted;
  }, [apps, search, showSystem, sort]);
  const projectList = projects.data ?? [];
  const workingCount = projectList.filter((p) => p.status === "decoding" || p.status === "building" || p.java === "working").length;

  const opened = (project: InspectorProjectView) => {
    haptic("success");
    setSheetApp(null);
    setOpenProject(project.id);
    void client.invalidateQueries({ queryKey: ["inspector", "projects", companyId] });
  };
  const failed = (title: string) => (error: unknown) => {
    haptic("warning");
    pushToast({ title, body: error instanceof Error ? error.message : String(error), tone: "error" });
  };

  const decompile = useMutation({
    mutationFn: async ({ app, options }: { app: PickerApp; options: InspectorDecodeOptions }) => {
      const extras = { label: app.label, packageName: app.package, splitCount: app.splitCount, options };
      if (app.sourceDir && app.apkUrl) {
        // Automa runs on this phone: it copies the APK from where Android keeps it.
        if (status.data?.kind === "phone") {
          setPhase("Copying the app…");
          try {
            return (await appInspectorApi.open(companyId!, { source: { kind: "path", apkPath: app.sourceDir }, ...extras })).project;
          } catch {
            // Termux couldn't read it there; send the bytes instead.
          }
        }
        setPhase("Reading the app…");
        const res = await fetch(app.apkUrl, { cache: "no-store" });
        if (!res.ok) throw new Error("The Automa app couldn't read that app's APK.");
        const blob = await res.blob();
        setPhase(`Sending ${formatBytes(blob.size)}…`);
        return (await appInspectorApi.upload(companyId!, blob, extras)).project;
      }
      setPhase("Copying the app…");
      return (await appInspectorApi.open(companyId!, { source: { kind: "installed", package: app.package }, ...extras })).project;
    },
    onSuccess: opened,
    onError: failed("Couldn't decompile that app"),
    onSettled: () => setPhase(null),
  });
  const uploadFile = useMutation({
    mutationFn: async (file: File) => {
      setPhase(`Sending ${formatBytes(file.size)}…`);
      return (await appInspectorApi.upload(companyId!, file, { label: file.name.replace(/\.apk$/i, "") })).project;
    },
    onSuccess: opened,
    onError: failed("Couldn't open that APK"),
    onSettled: () => setPhase(null),
  });
  const extract = useMutation({
    mutationFn: async (app: PickerApp) => {
      const res = await fetch(app.apkUrl!, { cache: "no-store" });
      if (!res.ok) throw new Error("The Automa app couldn't read that app's APK.");
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${app.label.replace(/[^\w.-]+/g, "_")}${app.versionName ? `-${app.versionName}` : ""}.apk`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    onSuccess: () => {
      haptic("success");
      pushToast({ title: "Saving the APK to Downloads", tone: "success" });
    },
    onError: failed("Couldn't save the APK"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => appInspectorApi.remove(companyId!, id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["inspector", "projects", companyId] }),
  });

  if (!companyId) return null;
  const busy = decompile.isPending || uploadFile.isPending;
  const listLoading = nativeAvailable ? nativeApps.isPending : status.isPending;
  const openedProject = projectList.find((p) => p.id === openProject);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3" data-testid="app-inspector-page">
      <header className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10" aria-hidden="true">
          <Boxes className="size-5 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg leading-tight font-semibold">App Inspector</h1>
          <p className="text-xs text-muted-foreground">Decompile, read as Java, edit and rebuild Android apps. For apps you made or may analyze.</p>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()} data-testid="inspector-choose-file">
          <FileUp /> APK
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          className="hidden"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = "";
            if (chosen) uploadFile.mutate(chosen);
          }}
        />
      </header>

      {status.isError && isServerTooOld(status.error) ? (
        <PhoneServerOutdated feature="The App Inspector" onRetry={() => void status.refetch()} />
      ) : status.isError ? (
        <div className="flex items-center gap-4 rounded-xl border border-dashed border-border p-4">
          <Mascot pose="confused" size="sm" />
          <p className="text-sm text-muted-foreground">The App Inspector runs on the device Automa runs on. Run Automa for yourself to use it.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 border-b border-border" role="tablist" aria-label="App Inspector">
            {(
              [
                { id: "apps" as const, label: "Apps", icon: LayoutGrid, count: apps.filter((app) => showSystem || !app.system).length || null },
                { id: "projects" as const, label: "Projects", icon: FolderOpen, count: projectList.length || null },
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
                }}
                className={cn(
                  "flex min-h-11 items-center justify-center gap-1.5 border-b-2 text-sm transition-colors",
                  tab === item.id ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
                data-testid={`inspector-tab-${item.id}`}
              >
                <item.icon className="size-4" aria-hidden="true" />
                {item.label}
                {item.count ? <span className="rounded-full bg-muted px-1.5 text-xs font-normal text-muted-foreground">{item.count}</span> : null}
                {item.id === "projects" && workingCount > 0 ? <Loader2 className="size-3 animate-spin text-primary" aria-hidden="true" /> : null}
              </button>
            ))}
          </div>

          {status.data && !status.data.apktoolReady ? (
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              {status.data.kind === "phone"
                ? "The first decompile installs apktool, jadx and a JDK in Termux (you'll see it in the log). That takes a few minutes, once."
                : "Decompiling needs apktool (and jadx for Java) installed on this computer."}
            </p>
          ) : null}

          {tab === "apps" ? (
            <section aria-label="Apps" className="flex flex-col gap-2">
              {apps.length > 0 || listLoading ? (
                <div className="flex items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                    <Input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search apps"
                      aria-label="Search apps"
                      className="h-10 pr-8 pl-9"
                      data-testid="inspector-search"
                    />
                    {search ? (
                      <button type="button" aria-label="Clear the search" className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground" onClick={() => setSearch("")}>
                        <X className="size-4" />
                      </button>
                    ) : null}
                  </div>
                  <select
                    value={sort}
                    onChange={(event) => setSort(event.target.value as Sort)}
                    aria-label="Sort apps"
                    className="h-10 rounded-md border border-border bg-background px-2 text-sm"
                    data-testid="inspector-sort"
                  >
                    <option value="name">Name</option>
                    <option value="size">Size</option>
                    <option value="updated">Updated</option>
                  </select>
                </div>
              ) : null}
              {systemCount > 0 ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <button
                    type="button"
                    aria-pressed={showSystem}
                    onClick={() => {
                      haptic("tick");
                      setShowSystem((value) => !value);
                    }}
                    className={cn("rounded-full border px-3 py-1", showSystem ? "border-primary bg-primary/10 text-primary" : "border-border")}
                    data-testid="inspector-system"
                  >
                    System apps
                  </button>
                  <span>{visibleApps.length} apps</span>
                </div>
              ) : null}

              {listLoading ? (
                <div className="flex flex-col gap-1">{Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
              ) : nativeApps.isError ? (
                <p className="text-sm text-destructive">{nativeApps.error instanceof Error ? nativeApps.error.message : "Couldn't list the apps on this phone"}</p>
              ) : apps.length === 0 ? (
                <div className="flex items-center gap-4 rounded-xl border border-dashed border-border p-4" data-testid="inspector-no-apps">
                  <Mascot pose="thinking" size="sm" />
                  <p className="text-sm text-muted-foreground">
                    {status.data?.kind === "phone"
                      ? "Open this page in the Automa app (1.8.0 or newer) to pick from the apps on this phone, or tap APK to choose a file."
                      : "Tap APK to choose a file. In the Automa app on a phone, the phone's apps are listed here."}
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card" data-testid="inspector-apps">
                  {visibleApps.map((app) => (
                    <li key={app.package}>
                      <button
                        type="button"
                        onClick={() => {
                          haptic("tick");
                          setSheetApp(app);
                        }}
                        className="flex min-h-16 w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/60"
                        data-testid="inspector-app"
                        data-package={app.package}
                      >
                        <AppIcon app={app} className="size-11" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{app.label}</span>
                          <span className="block truncate font-mono text-xs text-muted-foreground">{app.package}</span>
                        </span>
                        <span className="shrink-0 text-right text-xs text-muted-foreground">
                          {app.versionName ? <span className="block max-w-24 truncate">{app.versionName}</span> : null}
                          {app.sizeBytes ? <span className="block">{formatBytes(app.sizeBytes)}</span> : null}
                        </span>
                      </button>
                    </li>
                  ))}
                  {visibleApps.length === 0 ? <li className="px-4 py-6 text-center text-sm text-muted-foreground">No app matches.</li> : null}
                </ul>
              )}
            </section>
          ) : (
            <section aria-label="Projects" className="flex flex-col gap-2">
              {projects.isPending ? (
                <div className="flex flex-col gap-1">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
              ) : projectList.length === 0 ? (
                <div className="flex items-center gap-4 rounded-xl border border-dashed border-border p-4" data-testid="inspector-no-projects">
                  <Mascot pose="thinking" size="sm" />
                  <p className="text-sm text-muted-foreground">Apps you decompile show up here, ready to read, edit and build.</p>
                </div>
              ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                  {projectList.map((project) => {
                    const state = projectStatus(project);
                    return (
                      <li key={project.id} className="flex items-center gap-1 pr-1" data-testid="inspector-project">
                        <button
                          type="button"
                          className="flex min-h-16 min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left hover:bg-accent/60"
                          onClick={() => {
                            haptic("tick");
                            setOpenProject(project.id);
                          }}
                        >
                          <AppIcon app={{ iconUrl: project.packageName ? iconByPackage.get(project.packageName) ?? null : null }} className="size-11" />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-sm font-semibold">{project.label}</span>
                              <span className={cn("shrink-0 rounded-full px-2 text-xs", state.tone)}>{state.text}</span>
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {[
                                project.packageName,
                                new Date(project.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                        </button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${project.label}`}
                          onClick={() => {
                            if (window.confirm(`Delete the decompiled ${project.label}? Your edits in it are lost.`)) remove.mutate(project.id);
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      {uploadFile.isPending ? (
        <div className="fixed inset-x-3 bottom-(--sz-safe-bottom) z-30 mb-20 flex items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-lg" role="status">
          <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
          <span className="text-sm">{phase ?? "Sending the APK…"}</span>
        </div>
      ) : null}

      <AppActionsSheet
        app={sheetApp}
        busy={decompile.isPending}
        phase={phase}
        onDecompile={(app, options) => decompile.mutate({ app, options })}
        onExtract={nativeAvailable ? (app) => extract.mutate(app) : null}
        onAsk={
          askClaude.ready
            ? (app) => {
                haptic("tick");
                askClaude.ask(
                  `Tell me about the app ${app.label} (${app.package}) on my phone${app.versionName ? `, version ${app.versionName}` : ""}. I can decompile it in Automa's App Inspector and share any of its files with you. ` +
                    `If adb is linked on this phone (automa adb link in Termux), you can launch it with \`adb shell monkey -p ${app.package} 1\`, take screenshots with \`adb shell screencap -p /sdcard/shot.png\`, and drive it with \`adb shell input\`. What should I look at first?`,
                );
              }
            : null
        }
        onOpenChange={(open) => {
          if (!open && !decompile.isPending) setSheetApp(null);
        }}
      />

      {openProject ? (
        <ProjectExplorer
          companyId={companyId}
          projectId={openProject}
          iconUrl={openedProject?.packageName ? iconByPackage.get(openedProject.packageName) ?? null : null}
          onClose={() => {
            setOpenProject(null);
            setTab("projects");
            void projects.refetch();
          }}
        />
      ) : null}
    </div>
  );
}
