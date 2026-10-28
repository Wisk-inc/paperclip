import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, GitPullRequest, History, LoaderCircle, RotateCcw, Save, Sparkles, Trash2, Undo2 } from "lucide-react";
import type { StudioCheckpoint } from "@paperclipai/shared";
import { studioApi } from "@/api/studio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatBytes } from "@/lib/issue-output";
import { haptic } from "@/lib/haptics";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { cn } from "@/lib/utils";

const KIND = {
  manual: { icon: Bookmark, label: "Saved by you" },
  assistant: { icon: Sparkles, label: "Before the AI" },
  change: { icon: GitPullRequest, label: "Before a collaborator's change" },
  restore: { icon: Undo2, label: "Before going back" },
} as const satisfies Record<StudioCheckpoint["kind"], { icon: unknown; label: string }>;

interface StudioCheckpointsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onRestored: (checkpoint: StudioCheckpoint) => void;
}

/**
 * The project's history: copies saved before every AI turn, before accepting
 * a collaborator's change, and whenever you save one. Going back to one saves
 * the current files first, so that can be undone too.
 */
export function StudioCheckpointsSheet({ open, onOpenChange, workspaceId, onRestored }: StudioCheckpointsSheetProps) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const key = [...queryKeys.studio.detail(workspaceId), "checkpoints"] as const;
  const list = useQuery({ queryKey: key, queryFn: () => studioApi.checkpoints(workspaceId), enabled: open });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const save = useMutation({
    mutationFn: () => studioApi.saveCheckpoint(workspaceId, label.trim() || null),
    onSuccess: () => {
      haptic("success");
      setLabel("");
      void refresh();
    },
  });
  const restore = useMutation({
    mutationFn: (checkpointId: string) => studioApi.restoreCheckpoint(workspaceId, checkpointId),
    onSuccess: (result) => {
      haptic("success");
      setConfirming(null);
      void refresh();
      onRestored(result.restored);
    },
    onError: () => haptic("warning"),
  });
  const remove = useMutation({
    mutationFn: (checkpointId: string) => studioApi.deleteCheckpoint(workspaceId, checkpointId),
    onSuccess: () => void refresh(),
  });

  const checkpoints = list.data?.checkpoints ?? [];
  // A checkpoint that didn't save is said out loud: the person counts on it.
  const failed = (
    [
      [restore.error, "Couldn't go back"],
      [save.error, "Couldn't save the checkpoint"],
      [remove.error, "Couldn't delete the checkpoint"],
      [list.error, "Couldn't load the checkpoints"],
    ] as const
  ).find(([error]) => error);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-(--sz-85vh) gap-0 rounded-t-xl p-0 md:inset-x-auto md:left-1/2 md:w-full md:max-w-lg md:-translate-x-1/2" data-testid="studio-checkpoints">
        <SheetHeader className="border-b border-border">
          <SheetTitle className="flex items-center gap-2">
            <History className="size-4 text-primary" /> Checkpoints
          </SheetTitle>
          <SheetDescription>Go back to any of these if something went wrong. Automa saves one before every AI change.</SheetDescription>
        </SheetHeader>
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            save.mutate();
          }}
          className="flex gap-2 border-b border-border p-3"
        >
          <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Name this checkpoint (optional)" aria-label="Checkpoint name" className="h-9" maxLength={160} />
          <Button type="submit" size="sm" className="h-9" disabled={save.isPending} data-testid="studio-save-checkpoint">
            {save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />} Save now
          </Button>
        </form>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 pb-(--sz-calc-8) md:pb-3">
          {failed ? (
            <p className="mb-2 text-sm text-destructive" role="alert">
              {failed[0] instanceof Error ? `${failed[1]}: ${failed[0].message}` : failed[1]}
            </p>
          ) : null}
          {list.isLoading ? (
            <LoaderCircle className="mx-auto size-5 animate-spin text-muted-foreground" />
          ) : list.error && checkpoints.length === 0 ? null : checkpoints.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No checkpoints yet. One is saved before each AI change, or tap Save now.</p>
          ) : (
            <ol className="relative flex flex-col gap-2 border-l-2 border-border pl-4">
              {checkpoints.map((checkpoint) => {
                const kind = KIND[checkpoint.kind] ?? KIND.manual;
                const Icon = kind.icon;
                return (
                  <li key={checkpoint.id} className="relative rounded-xl border border-border bg-card p-3" data-testid="studio-checkpoint">
                    <span className="absolute top-4 -left-6 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground ring-4 ring-background">
                      <Icon className="size-2.5" />
                    </span>
                    <p className="text-sm font-medium">{checkpoint.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {kind.label} · {timeAgo(checkpoint.createdAt)} · {checkpoint.fileCount} {checkpoint.fileCount === 1 ? "file" : "files"}, {formatBytes(checkpoint.bytes)}
                      {checkpoint.skippedFiles ? ` · ${checkpoint.skippedFiles} large files left out` : ""}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        variant={confirming === checkpoint.id ? "default" : "outline"}
                        disabled={restore.isPending}
                        onClick={() => (confirming === checkpoint.id ? restore.mutate(checkpoint.id) : setConfirming(checkpoint.id))}
                        className={cn(confirming === checkpoint.id && "flex-1")}
                        data-testid="studio-restore-checkpoint"
                      >
                        {restore.isPending && restore.variables === checkpoint.id ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
                        {confirming === checkpoint.id ? "Tap again to go back here" : "Go back here"}
                      </Button>
                      <Button size="sm" variant="ghost" aria-label="Delete checkpoint" disabled={remove.isPending} onClick={() => remove.mutate(checkpoint.id)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
