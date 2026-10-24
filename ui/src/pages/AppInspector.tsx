import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Boxes, FileCode2, Folder, Hammer, Loader2, Save, Sparkles, Trash2 } from "lucide-react";
import { appInspectorApi, type InspectorFileNode, type InspectorProjectView } from "@/api/app-inspector";
import { Mascot } from "@/components/mascot/Mascot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

/** Browse and read the decoded files of one project. */
function ProjectView({ companyId, projectId, onBack }: { companyId: string; projectId: string; onBack: () => void }) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const [cwd, setCwd] = useState("");
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [explanation, setExplanation] = useState<string | null>(null);

  const project = useQuery({
    queryKey: ["inspector", "project", companyId, projectId],
    queryFn: () => appInspectorApi.project(companyId, projectId).then((r) => r.project),
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "decoding" || s === "building" ? 1500 : false;
    },
  });
  const ready = project.data && project.data.status !== "decoding" && project.data.status !== "failed";
  const dir = useQuery({
    queryKey: ["inspector", "dir", companyId, projectId, cwd],
    queryFn: () => appInspectorApi.dir(companyId, projectId, cwd).then((r) => r.entries),
    enabled: Boolean(ready && openFile === null),
  });
  const file = useQuery({
    queryKey: ["inspector", "file", companyId, projectId, openFile],
    queryFn: () => appInspectorApi.file(companyId, projectId, openFile!).then((r) => r.text),
    enabled: Boolean(openFile),
  });
  useEffect(() => {
    if (file.data !== undefined) setDraft(file.data);
  }, [file.data]);
  useEffect(() => setExplanation(null), [openFile]);

  const save = useMutation({
    mutationFn: () => appInspectorApi.writeFile(companyId, projectId, openFile!, draft),
    onSuccess: () => {
      haptic("success");
      pushToast({ title: "Saved", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Couldn't save", body: error instanceof Error ? error.message : String(error), tone: "error" }),
  });
  const explain = useMutation({
    mutationFn: () => appInspectorApi.explain(companyId, projectId, openFile!),
    onSuccess: ({ explanation: text }) => setExplanation(text),
    onError: (error) => pushToast({ title: "Claude couldn't read it", body: error instanceof Error ? error.message : String(error), tone: "error" }),
  });
  const rebuild = useMutation({
    mutationFn: () => appInspectorApi.rebuild(companyId, projectId),
    onSuccess: () => {
      haptic("tick");
      void client.invalidateQueries({ queryKey: ["inspector", "project", companyId, projectId] });
    },
    onError: (error) => pushToast({ title: "Couldn't rebuild", body: error instanceof Error ? error.message : String(error), tone: "error" }),
  });

  const p = project.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="Back to apps" onClick={onBack}><ArrowLeft /></Button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{p?.label ?? "Loading…"}</span>
        {ready ? (
          <Button size="sm" disabled={rebuild.isPending || p?.status === "building"} onClick={() => rebuild.mutate()} data-testid="inspector-rebuild">
            {p?.status === "building" ? <Loader2 className="animate-spin" /> : <Hammer />} Rebuild
          </Button>
        ) : null}
      </div>

      {p?.status === "built" && p.outputPath ? (
        <p className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground" data-testid="inspector-output">
          Rebuilt and signed. Saved to your Downloads: <span className="font-mono">{p.outputPath}</span>
        </p>
      ) : null}

      {p && (p.status === "decoding" || p.status === "building" || p.status === "failed") ? (
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            {p.status === "failed" ? null : <Loader2 className="size-4 animate-spin" />}
            {p.status === "decoding" ? "Decoding the app…" : p.status === "building" ? "Rebuilding…" : "It didn't finish — see the log."}
          </span>
          <pre className="max-h-64 overflow-auto rounded-lg bg-muted px-2 py-1.5 font-mono text-(length:--text-micro) text-muted-foreground whitespace-pre-wrap" data-testid="inspector-log">
            {p.logTail || "…"}
          </pre>
        </div>
      ) : null}

      {ready && openFile === null ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <button type="button" className="hover:text-foreground" onClick={() => setCwd("")}>root</button>
            {cwd ? <span className="font-mono">/{cwd}</span> : null}
            {cwd ? <button type="button" className="ml-auto hover:text-foreground" onClick={() => setCwd(parentPath(cwd))}>Up</button> : null}
          </div>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card" data-testid="inspector-tree">
            {(dir.data ?? []).map((entry: InspectorFileNode) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm hover:bg-accent/60"
                  onClick={() => (entry.dir ? setCwd(entry.path) : setOpenFile(entry.path))}
                >
                  {entry.dir ? <Folder className="size-4 text-muted-foreground" /> : <FileCode2 className="size-4 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.name}</span>
                </button>
              </li>
            ))}
            {dir.data && dir.data.length === 0 ? <li className="px-3 py-2 text-xs text-muted-foreground">Empty folder.</li> : null}
          </ul>
        </div>
      ) : null}

      {openFile !== null ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpenFile(null)}><ArrowLeft className="size-3.5" /> Files</Button>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{openFile}</span>
          </div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="min-h-64 w-full rounded-lg border border-border bg-(--terminal-surface) p-2 font-mono text-(length:--text-micro) text-foreground"
            data-testid="inspector-file"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={save.isPending || file.data === draft} onClick={() => save.mutate()}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
            </Button>
            <Button size="sm" variant="outline" disabled={explain.isPending} onClick={() => explain.mutate()} data-testid="inspector-explain">
              {explain.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />} Explain with Claude
            </Button>
          </div>
          {explanation ? (
            <div className="rounded-lg border border-border bg-card p-3 text-sm whitespace-pre-wrap" data-testid="inspector-explanation">{explanation}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * App Inspector: decode an Android app with apktool, read its manifest,
 * resources and code (and ask Claude to explain them), edit the files, and
 * rebuild a signed APK to your Downloads. For apps you made or are authorized
 * to analyze.
 */
export function AppInspector() {
  const { selectedCompanyId: companyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [appPackage, setAppPackage] = useState("");
  const [apkPath, setApkPath] = useState("");

  useEffect(() => setBreadcrumbs([{ label: "App Inspector" }]), [setBreadcrumbs]);

  const status = useQuery({
    queryKey: ["inspector", "status", companyId],
    queryFn: () => appInspectorApi.status(companyId!),
    enabled: Boolean(companyId),
  });
  const projects = useQuery({
    queryKey: ["inspector", "projects", companyId],
    queryFn: () => appInspectorApi.projects(companyId!).then((r) => r.projects),
    enabled: Boolean(companyId) && !selected,
    refetchInterval: (query) => ((query.state.data ?? []).some((p: InspectorProjectView) => p.status === "decoding" || p.status === "building") ? 2000 : false),
  });

  const open = useMutation({
    mutationFn: () =>
      appInspectorApi.open(companyId!, {
        source: appPackage ? { kind: "installed", package: appPackage } : { kind: "path", apkPath: apkPath.trim() },
      }),
    onSuccess: ({ project }) => {
      haptic("tick");
      setAppPackage("");
      setApkPath("");
      setSelected(project.id);
      void client.invalidateQueries({ queryKey: ["inspector", "projects", companyId] });
    },
    onError: (error) => pushToast({ title: "Couldn't open that app", body: error instanceof Error ? error.message : String(error), tone: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => appInspectorApi.remove(companyId!, id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["inspector", "projects", companyId] }),
  });

  const apps = useMemo(() => status.data?.apps ?? [], [status.data]);
  if (!companyId) return null;

  if (selected) {
    return (
      <div className="mx-auto w-full max-w-3xl" data-testid="app-inspector-page">
        <ProjectView companyId={companyId} projectId={selected} onBack={() => { setSelected(null); void projects.refetch(); }} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5" data-testid="app-inspector-page">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold"><Boxes className="size-5 text-muted-foreground" aria-hidden="true" /> App Inspector</h1>
        <p className="text-sm text-muted-foreground">
          Decode an Android app to read its manifest, resources and code, ask Claude to explain them, edit the files, and rebuild a signed
          APK to your Downloads. For apps you made or are authorized to analyze.
        </p>
      </header>

      {status.isError ? (
        <div className="flex items-center gap-4 rounded-xl border border-dashed border-border p-4">
          <Mascot pose="confused" size="sm" />
          <p className="text-sm text-muted-foreground">The App Inspector runs on the device Automa runs on. Run Automa for yourself to use it.</p>
        </div>
      ) : (
        <>
          <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Open an app">
            <h2 className="text-sm font-semibold">Open an app</h2>
            {!status.data?.apktoolReady ? (
              <p className="text-xs text-muted-foreground">The first time, decoding installs apktool and a JDK (shown in the log). That can take a minute.</p>
            ) : null}
            {apps.length > 0 ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Installed app</span>
                <select
                  value={appPackage}
                  onChange={(event) => { setAppPackage(event.target.value); setApkPath(""); }}
                  className="h-10 rounded-lg border border-border bg-background px-2 text-sm"
                  data-testid="inspector-app-select"
                >
                  <option value="">Choose an app…</option>
                  {apps.map((pkg) => <option key={pkg} value={pkg}>{pkg}</option>)}
                </select>
              </label>
            ) : null}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{apps.length > 0 ? "…or an APK file path" : "APK file path on this device"}</span>
              <Input value={apkPath} onChange={(event) => { setApkPath(event.target.value); setAppPackage(""); }} placeholder="/sdcard/Download/app.apk" className="h-10 font-mono text-sm" />
            </label>
            <div>
              <Button size="sm" disabled={open.isPending || (!appPackage && !apkPath.trim())} onClick={() => open.mutate()} data-testid="inspector-open">
                {open.isPending ? <Loader2 className="animate-spin" /> : <FileCode2 />} Decode
              </Button>
            </div>
          </section>

          {(projects.data ?? []).length > 0 ? (
            <section aria-label="Decoded apps" className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">Decoded apps</h2>
              <ul className="flex flex-col gap-2">
                {(projects.data ?? []).map((project) => (
                  <li key={project.id} className="flex items-center gap-3 rounded-xl border border-border bg-card p-3" data-testid="inspector-project">
                    <Boxes className="size-4 text-muted-foreground" />
                    <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium" onClick={() => setSelected(project.id)}>
                      {project.label}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {project.status === "ready" ? "Ready to read and edit" : project.status === "built" ? "Rebuilt · in Downloads" : project.status === "failed" ? "Didn't finish" : "Working…"}
                      </span>
                    </button>
                    <Button variant="ghost" size="icon-sm" aria-label="Delete" onClick={() => remove.mutate(project.id)}><Trash2 /></Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
