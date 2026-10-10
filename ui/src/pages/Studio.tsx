import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Ellipsis, FileArchive, FolderOpen, Globe, LogIn, Pencil, Plus, Rocket, Share2, Sparkles, SquareTerminal, Trash2, Users } from "lucide-react";
import { studioApi, type StudioCatalogLanguage } from "../api/studio";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { haptic } from "../lib/haptics";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { Link, useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Mascot } from "../components/mascot/Mascot";
import { ThumbAction } from "../components/ThumbAction";
import { PageSkeleton } from "../components/PageSkeleton";
import { NewStudioAppSheet, type NewStudioAppInput } from "../components/studio/NewStudioAppSheet";
import { LanguageLogo } from "../components/studio/LanguageLogo";
import { GitHubMark } from "../components/studio/GitHubMark";
import { useUndoableAction } from "../hooks/useUndoableAction";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** Where a join code or invite link takes you: the collaborator page. */
export function studioJoinTarget(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).toString();
    } catch {
      return null;
    }
  }
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length >= 4 ? `/studio-guest/?code=${encodeURIComponent(code)}` : null;
}

/** Languages offered as one-tap starting points, in this order. */
const QUICK_STARTS = ["html", "python", "fullstack-node", "react", "flask", "javascript", "go", "rust", "pwa", "typescript"];

const TIPS = [
  { icon: Sparkles, title: "Describe it, get an app", body: "Tell the AI assistant what you want. It writes the UI, the logic, and the database, then runs it." },
  { icon: Globe, title: "Share a live link", body: "Your app runs on this device. One tap gives it a public Cloudflare link anyone can open." },
  { icon: Users, title: "Build with friends", body: "Share a code. They watch you type, chat, send files, and suggest changes you approve." },
  { icon: GitHubMark, title: "Bring a GitHub project", body: "Paste a repository link to clone it, then ask the assistant to set it up or fix it." },
];

function kindLabel(language: StudioCatalogLanguage | undefined) {
  if (!language) return null;
  return language.kind === "web" ? "Web app" : language.kind === "static" ? "Website" : "Console app";
}

/**
 * App Studio: apps you build and run on this device. Start one in any of the
 * languages, clone one from GitHub, or join someone else's project.
 */
export function Studio() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [newOpen, setNewOpen] = useState(false);
  const [startWith, setStartWith] = useState<string | null>(null);
  const [join, setJoin] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: "App Studio" }]);
  }, [setBreadcrumbs]);

  const catalog = useQuery({
    queryKey: queryKeys.studio.catalog(companyId),
    queryFn: () => studioApi.catalog(companyId),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });
  const list = useQuery({
    queryKey: queryKeys.studio.list(companyId),
    queryFn: () => studioApi.list(companyId),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const create = useMutation({
    mutationFn: (input: NewStudioAppInput) => studioApi.create(companyId, input),
    onSuccess: (result, input) => {
      haptic("success");
      void queryClient.invalidateQueries({ queryKey: queryKeys.studio.list(companyId) });
      setNewOpen(false);
      navigate(`/studio/${result.workspace.id}`, { state: input.description ? { prompt: input.description } : undefined });
    },
  });

  const removal = useUndoableAction({
    commit: async (id) => {
      await studioApi.remove(id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.studio.list(companyId) });
    },
  });
  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) => studioApi.update(input.id, { name: input.name }),
    onSuccess: () => {
      haptic("success");
      setRenaming(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.studio.list(companyId) });
    },
  });

  const languageById = useMemo(() => new Map((catalog.data?.languages ?? []).map((language) => [language.id, language])), [catalog.data]);
  const workspaces = (list.data?.workspaces ?? []).filter((workspace) => !removal.hiddenIds.has(workspace.id));
  const running = workspaces.filter((workspace) => workspace.run?.status === "running" || workspace.run?.status === "starting").length;
  const shared = workspaces.filter((workspace) => workspace.shareEnabled).length;
  const quickStarts = QUICK_STARTS.map((id) => languageById.get(id)).filter((language): language is StudioCatalogLanguage => Boolean(language));

  /** Opens the New app sheet, optionally on a language or on "github". */
  const openNew = (start: string | null = null) => {
    haptic("tick");
    setStartWith(start);
    setNewOpen(true);
  };

  const onJoin = (event: FormEvent) => {
    event.preventDefault();
    const target = studioJoinTarget(join);
    if (!target) {
      pushToast({ title: "Paste an invite link or a join code", tone: "error" });
      return;
    }
    if (target.startsWith("/")) window.location.assign(target);
    else window.open(target, "_blank", "noopener");
  };

  if (!selectedCompanyId || (list.isLoading && !list.data)) return <PageSkeleton variant="list" />;

  return (
    <div className="flex flex-col gap-6" data-testid="studio-page">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl border border-border bg-linear-to-br from-primary/25 via-card to-card p-4 md:p-6">
        <div className="flex items-center gap-4">
          <Mascot pose={running ? "cheering" : "excited"} size="md" className="shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-2xl font-bold tracking-tight md:text-3xl">App Studio</h1>
            <p className="text-sm text-muted-foreground md:text-base">
              Build, run, and share apps in {catalog.data?.languages.length ?? "50+"} languages, right from this device.
            </p>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-2">
          {[
            { label: "Apps", value: workspaces.length, icon: SquareTerminal },
            { label: "Running", value: running, icon: Rocket },
            { label: "Shared", value: shared, icon: Share2 },
          ].map((stat) => (
            <div key={stat.label} className="rounded-xl border border-border/60 bg-background/70 p-3 backdrop-blur">
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <stat.icon className="size-3.5" /> {stat.label}
              </dt>
              <dd className="mt-0.5 text-2xl font-semibold tabular-nums">{stat.value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 hidden gap-2 md:flex">
          <Button onClick={() => openNew()}>
            <Plus /> New app
          </Button>
          <Button variant="outline" onClick={() => openNew("github")}>
            <GitHubMark /> Clone from GitHub
          </Button>
        </div>
      </section>

      {/* Quick starts */}
      {quickStarts.length ? (
        <section aria-labelledby="studio-quick-heading" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 id="studio-quick-heading" className="text-sm font-semibold">
              Start something new
            </h2>
            <button type="button" onClick={() => openNew()} className="flex items-center gap-0.5 text-sm text-muted-foreground hover:text-foreground">
              All languages <ChevronRight className="size-4" />
            </button>
          </div>
          <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:grid md:grid-cols-5 md:px-0 xl:grid-cols-10" data-testid="studio-quick-starts">
            {quickStarts.map((language) => (
              <li key={language.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => openNew(language.id)}
                  className="flex h-full w-28 flex-col items-center gap-2 rounded-xl border border-border bg-card p-3 text-center transition-colors hover:border-primary hover:bg-accent/50 md:w-full"
                  data-testid={`studio-quick-${language.id}`}
                >
                  <LanguageLogo language={language} size="lg" />
                  <span className="line-clamp-2 text-xs font-medium leading-tight">{language.name.replace(/ \(.*\)$/, "")}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Your apps */}
      <section aria-labelledby="studio-apps-heading" className="flex flex-col gap-2">
        <h2 id="studio-apps-heading" className="text-sm font-semibold">
          Your apps
        </h2>
        {list.error ? <p className="text-sm text-destructive">{list.error instanceof Error ? list.error.message : "Couldn't load your apps"}</p> : null}
        {workspaces.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border p-6 text-center">
            <Mascot pose="idle" size="sm" gaze="down" />
            <p className="text-sm font-medium">No apps yet</p>
            <p className="max-w-xs text-sm text-muted-foreground">Pick a language above, or describe an app and let the assistant build it.</p>
            <Button onClick={() => openNew()}>
              <Plus /> New app
            </Button>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Your apps">
            {workspaces.map((workspace) => {
              const language = languageById.get(workspace.language);
              const isRunning = workspace.run?.status === "running" || workspace.run?.status === "starting";
              return (
                <li key={workspace.id} className="relative">
                  <Link
                    to={`/studio/${workspace.id}`}
                    className="group flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-3 pr-12 transition-colors hover:border-primary/60 hover:bg-accent/40"
                    data-testid="studio-app-card"
                  >
                    <div className="flex items-start gap-3">
                      <LanguageLogo language={language ?? { id: "unknown", abbr: "</>", color: "var(--muted-foreground)", name: workspace.language }} size="lg" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{workspace.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {language?.name ?? workspace.language}
                          {kindLabel(language) ? ` · ${kindLabel(language)}` : ""}
                        </p>
                      </div>
                    </div>
                    {workspace.description ? <p className="line-clamp-2 text-sm text-muted-foreground">{workspace.description}</p> : null}
                    <div className="mt-auto flex flex-wrap items-center gap-1.5 text-xs">
                      {isRunning ? (
                        <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-medium text-(--status-agent-running)">
                          <span className="size-1.5 animate-pulse rounded-full bg-current" /> Running
                        </span>
                      ) : null}
                      {workspace.run?.publicUrl ? (
                        <span className="flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 font-medium text-primary">
                          <Globe className="size-3" /> Public link
                        </span>
                      ) : null}
                      {workspace.shareEnabled ? (
                        <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                          <Users className="size-3" /> Shared
                        </span>
                      ) : null}
                      {workspace.sourceUrl ? (
                        <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                          <GitHubMark className="size-3" /> GitHub
                        </span>
                      ) : null}
                      <span className="ml-auto text-muted-foreground">
                        {workspace.lastRunAt ? `Ran ${timeAgo(workspace.lastRunAt)}` : `Made ${timeAgo(workspace.createdAt)}`}
                      </span>
                    </div>
                  </Link>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" aria-label={`More for ${workspace.name}`} data-testid="studio-app-menu">
                        <Ellipsis />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem onSelect={() => navigate(`/studio/${workspace.id}`)}>
                        <FolderOpen /> Open
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setRenaming({ id: workspace.id, name: workspace.name })} data-testid="studio-app-rename">
                        <Pencil /> Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <a href={studioApi.archiveUrl(workspace.id)} download>
                          <FileArchive /> Download as zip
                        </a>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => removal.run(workspace.id, `Deleted ${workspace.name}`)} data-testid="studio-app-delete">
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Join */}
      <form onSubmit={onJoin} className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-primary" />
          <span className="text-sm font-semibold">Join someone's project</span>
        </div>
        <p className="text-sm text-muted-foreground">Paste the invite link or join code a friend sent you.</p>
        <div className="flex gap-2">
          <Input value={join} onChange={(event) => setJoin(event.target.value)} placeholder="Invite link or join code" aria-label="Invite link or join code" className="h-10" />
          <Button type="submit" variant="outline" className="h-10">
            <LogIn /> Join
          </Button>
        </div>
      </form>

      {/* Tips */}
      <section aria-labelledby="studio-tips-heading" className="flex flex-col gap-2">
        <h2 id="studio-tips-heading" className="text-sm font-semibold">
          What you can do
        </h2>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {TIPS.map((tip) => (
            <li key={tip.title} className="flex gap-3 rounded-xl border border-border bg-card p-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <tip.icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{tip.title}</span>
                <span className="block text-sm text-muted-foreground">{tip.body}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {workspaces.length ? <ThumbAction label="New app" onClick={() => openNew()} /> : null}

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename app</DialogTitle>
            <DialogDescription>Only the name changes; files and links stay the same.</DialogDescription>
          </DialogHeader>
          <form
            id="studio-rename-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming?.name.trim()) rename.mutate({ id: renaming.id, name: renaming.name.trim() });
            }}
          >
            <Input
              autoFocus
              value={renaming?.name ?? ""}
              onChange={(event) => setRenaming((current) => (current ? { ...current, name: event.target.value } : current))}
              maxLength={80}
              aria-label="App name"
              data-testid="studio-rename-input"
            />
          </form>
          <DialogFooter className="flex-row justify-between sm:justify-between">
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button type="submit" form="studio-rename-form" disabled={rename.isPending || !renaming?.name.trim()} data-testid="studio-rename-save">
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <NewStudioAppSheet
        open={newOpen}
        onOpenChange={setNewOpen}
        catalog={catalog.data}
        startWith={startWith}
        onCreate={async (input) => {
          await create.mutateAsync(input);
        }}
      />
    </div>
  );
}
