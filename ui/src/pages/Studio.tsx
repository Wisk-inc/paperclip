import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CodeXml, LogIn, Plus } from "lucide-react";
import { studioApi } from "../api/studio";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { haptic } from "../lib/haptics";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { Link, useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "../components/EmptyState";
import { ThumbAction } from "../components/ThumbAction";
import { PageSkeleton } from "../components/PageSkeleton";
import { LanguageBadge, NewStudioAppSheet, type NewStudioAppInput } from "../components/studio/NewStudioAppSheet";

/** Where a join code or invite link takes you: the collaborator page. */
export function studioJoinTarget(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.toString();
    } catch {
      return null;
    }
  }
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length >= 4 ? `/studio-guest/?code=${encodeURIComponent(code)}` : null;
}

/**
 * Studio: apps you build and run on this device. Start one in any of the
 * languages, clone one from GitHub, or join someone else's project.
 */
export function Studio() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [newOpen, setNewOpen] = useState(false);
  const [join, setJoin] = useState("");
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

  const languageById = new Map((catalog.data?.languages ?? []).map((language) => [language.id, language]));
  const workspaces = list.data?.workspaces ?? [];

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

  const joinCard = (
    <form onSubmit={onJoin} className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <span className="text-sm font-medium">Join someone's project</span>
      <div className="flex gap-2">
        <Input value={join} onChange={(event) => setJoin(event.target.value)} placeholder="Invite link or join code" aria-label="Invite link or join code" className="h-9" />
        <Button type="submit" variant="outline" size="sm" className="h-9">
          <LogIn /> Join
        </Button>
      </div>
    </form>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="studio-page">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">App Studio</h1>
          <p className="text-sm text-muted-foreground">Build apps in {catalog.data?.languages.length ?? "50+"} languages, run them on this device, and share them.</p>
        </div>
        <Button className="hidden md:inline-flex" onClick={() => setNewOpen(true)}>
          <Plus /> New app
        </Button>
      </div>

      {list.error ? <p className="text-sm text-destructive">{list.error instanceof Error ? list.error.message : "Couldn't load your apps"}</p> : null}

      {workspaces.length === 0 ? (
        <>
          <EmptyState
            icon={CodeXml}
            title="Build your first app"
            message="Pick a language, name it, and it's ready to run."
            description="Write code yourself, or describe it and let the AI assistant build it with your own API key."
            action="New app"
            onAction={() => setNewOpen(true)}
            steps={["Pick a language or paste a GitHub link", "Run it and watch the console", "Preview it, or get a public link", "Invite friends to build with you"]}
          />
          {joinCard}
        </>
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Your apps">
            {workspaces.map((workspace) => {
              const language = languageById.get(workspace.language);
              const running = workspace.run?.status === "running" || workspace.run?.status === "starting";
              return (
                <li key={workspace.id}>
                  <Link
                    to={`/studio/${workspace.id}`}
                    className="flex items-center gap-3 rounded-lg border border-border p-3 hover:bg-accent/50"
                    data-testid="studio-app-card"
                  >
                    {language ? <LanguageBadge language={language} /> : <span className="flex size-9 items-center justify-center rounded-md bg-muted font-mono text-xs">{"</>"}</span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{workspace.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {language?.name ?? workspace.language}
                        {workspace.sourceUrl ? " · from GitHub" : ""}
                        {workspace.shareEnabled ? " · shared" : ""}
                        {" · "}
                        {workspace.lastRunAt ? `ran ${timeAgo(workspace.lastRunAt)}` : `made ${timeAgo(workspace.createdAt)}`}
                      </span>
                    </span>
                    {running ? (
                      <span className="flex items-center gap-1 text-xs font-medium text-(--status-agent-running)" aria-label="Running">
                        <span className="size-2 rounded-full bg-current" /> Running
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
          {joinCard}
          <ThumbAction label="New app" onClick={() => setNewOpen(true)} />
        </>
      )}

      <NewStudioAppSheet
        open={newOpen}
        onOpenChange={setNewOpen}
        catalog={catalog.data}
        onCreate={async (input) => {
          await create.mutateAsync(input);
        }}
      />
    </div>
  );
}
