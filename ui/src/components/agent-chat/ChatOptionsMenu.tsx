import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, MessageSquareX, MoreHorizontal, Pencil, Pin, PinOff, ScrollText, SquareTerminal, UserRoundX } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentChatsApi } from "@/api/agentChats";
import { issuesApi } from "@/api/issues";
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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToastActions } from "@/context/ToastContext";
import { useResourceMembershipMutation, useResourceMemberships } from "@/hooks/useResourceMemberships";
import { haptic } from "@/lib/haptics";
import { EditAgentSheet, type EditAgentTab } from "./EditAgentSheet";
import { AgentTerminalSheet } from "./AgentTerminalSheet";
import { RemoveAgentDialog } from "./RemoveAgentDialog";

interface ChatOptionsMenuProps {
  agent: Agent;
  /** The chat's task, when the caller already has it. */
  chatIssueId?: string | null;
  /** Reordering, for chat lists. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Runs after the chat is deleted (for example, leave the chat page). */
  afterDelete?: () => void;
}

/**
 * Everything you can do with one chat: pin it to the top, move it up or down
 * the list, rename the agent or edit its system prompt, see the agent's
 * terminal, delete the whole conversation, or remove the agent.
 */
export function ChatOptionsMenu({ agent, chatIssueId, onMoveUp, onMoveDown, afterDelete }: ChatOptionsMenuProps) {
  const client = useQueryClient();
  const { pushToast } = useToastActions();
  const memberships = useResourceMemberships(agent.companyId);
  const star = useResourceMembershipMutation(agent.companyId);
  const pinned = memberships.data?.starredAgentIds?.includes(agent.id) ?? false;
  const [editing, setEditing] = useState<EditAgentTab | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const deleteChat = useMutation({
    mutationFn: async () => {
      const issueId = chatIssueId ?? (await agentChatsApi.get(agent.companyId, agent.id))?.id;
      if (!issueId) throw new Error(`There is no chat with ${agent.name} to delete yet.`);
      await issuesApi.remove(issueId);
    },
    onSuccess: async () => {
      haptic("success");
      pushToast({ title: `Chat with ${agent.name} deleted`, tone: "success" });
      await client.invalidateQueries({ predicate: (query) => query.queryKey[0] === "agent-chat" || query.queryKey[0] === "issues" });
      afterDelete?.();
    },
    onError: (error) => {
      haptic("warning");
      pushToast({ title: "Couldn’t delete the chat", body: error instanceof Error ? error.message : String(error), tone: "error" });
    },
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`Options for the chat with ${agent.name}`} data-slot="chat-options" onClick={() => haptic("tick")}>
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            onSelect={() => {
              haptic("tick");
              star.mutate({ resourceType: "agent", resourceId: agent.id, resourceName: agent.name, starred: !pinned });
              pushToast({ title: pinned ? `Unpinned ${agent.name}` : `Pinned ${agent.name} to the top`, tone: "info" });
            }}
          >
            {pinned ? <PinOff className="size-4" aria-hidden="true" /> : <Pin className="size-4" aria-hidden="true" />}
            {pinned ? "Unpin chat" : "Pin to top"}
          </DropdownMenuItem>
          {onMoveUp ? (
            <DropdownMenuItem onSelect={onMoveUp}>
              <ArrowUp className="size-4" aria-hidden="true" />
              Move up
            </DropdownMenuItem>
          ) : null}
          {onMoveDown ? (
            <DropdownMenuItem onSelect={onMoveDown}>
              <ArrowDown className="size-4" aria-hidden="true" />
              Move down
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setEditing("profile")}>
            <Pencil className="size-4" aria-hidden="true" />
            Rename or change role
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditing("prompt")}>
            <ScrollText className="size-4" aria-hidden="true" />
            System prompt
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setTerminal(true)}>
            <SquareTerminal className="size-4" aria-hidden="true" />
            Terminal
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <MessageSquareX className="size-4" aria-hidden="true" />
            Delete chat
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmRemove(true)}>
            <UserRoundX className="size-4" aria-hidden="true" />
            Remove {agent.name}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <EditAgentSheet agent={agent} open={editing !== null} initialTab={editing ?? "profile"} onOpenChange={(next) => !next && setEditing(null)} />
      <AgentTerminalSheet agent={agent} open={terminal} onOpenChange={setTerminal} />
      <RemoveAgentDialog agent={agent} open={confirmRemove} onOpenChange={setConfirmRemove} />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the chat with {agent.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              All messages and files in this chat are deleted. {agent.name} stays in your organization, and a new chat starts
              the next time you message them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep chat</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteChat.mutate()}
            >
              Delete chat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
