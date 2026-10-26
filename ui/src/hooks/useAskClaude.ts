import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { useToastActions } from "@/context/ToastContext";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { openChatWithDraft, pickChatAgent } from "@/lib/ask-in-chat";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";

/**
 * "Ask Claude": open a chat with one of the organization's agents with a
 * question already typed. `ready` is false until the agent list and the
 * session have loaded, when the organization has no agent that can be
 * invoked, and when Agent Chat is turned off in Experimental settings.
 */
export function useAskClaude(companyId: string | null | undefined) {
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const chat = useAgentChatEnabled();
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? ""),
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId),
    staleTime: 60_000,
  });
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession(), retry: false, staleTime: 60_000 });
  const agent = pickChatAgent(agents.data ?? []);
  // The same value the chat page puts in its draft key (IssueDetail's
  // currentUserId), including "null" for a local board without sign-in. The
  // chat page waits for the session before reading, so this must too: a tap
  // before the session is known would file the question under the wrong key.
  const userId = String(session.data?.user?.id ?? session.data?.session?.userId ?? null);
  const ready = Boolean(companyId && agent && chat.enabled && session.isFetched);
  const ask = useCallback(
    (text: string) => {
      if (!ready || !companyId || !agent) return false;
      const stored = openChatWithDraft(navigate, { companyId, userId, agent, text });
      if (!stored) {
        void copyTextToClipboard(text);
        pushToast({
          title: "Question copied",
          body: "This chat is still sending a message, so the question couldn't be typed in for you. Paste it once that finishes.",
          tone: "info",
        });
      }
      return true;
    },
    [ready, companyId, agent, userId, navigate, pushToast],
  );
  return { agent, ready, ask };
}
