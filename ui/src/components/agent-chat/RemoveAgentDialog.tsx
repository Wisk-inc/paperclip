import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToastActions } from "@/context/ToastContext";
import { haptic } from "@/lib/haptics";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";

/**
 * Confirms, then deletes an agent for good. Its tasks stay (unassigned) and
 * its reports move to the top of the org. If you are on the agent's chat or
 * page, you land on Chats.
 */
export function RemoveAgentDialog({ agent, open, onOpenChange, onRemoved }: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoved?: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToastActions();
  const remove = useMutation({
    mutationFn: () => agentsApi.remove(agent.id, agent.companyId),
    onSuccess: async () => {
      haptic("success");
      pushToast({ title: `${agent.name} removed`, body: "Their tasks stay, unassigned.", tone: "success" });
      onOpenChange(false);
      onRemoved?.();
      if (new RegExp(`/(chats|agents)/${agentRouteRef(agent)}(?=$|[/?#])`).test(location.pathname)) navigate("/chats", { replace: true });
      await client.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) });
      await client.invalidateQueries({ queryKey: queryKeys.org(agent.companyId) });
      client.removeQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    },
    onError: (error) => {
      haptic("warning");
      onOpenChange(false);
      pushToast({ title: `Couldn’t remove ${agent.name}`, body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={(next) => !remove.isPending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {agent.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {agent.name} stops working and leaves your organization for good. Their tasks stay but are unassigned, and anyone
            who reports to {agent.name} moves to the top of the org. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Keep {agent.name}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={remove.isPending}
            onClick={(event) => {
              event.preventDefault();
              remove.mutate();
            }}
          >
            {remove.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Remove agent
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
