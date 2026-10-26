import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { openChatWithDraft, pickChatAgent } from "@/lib/ask-in-chat";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";

/**
 * "Ask Claude": open a chat with one of the organization's agents with a
 * question already typed. `agent` is null until the agent list has loaded, or
 * when the organization has no agents yet.
 */
export function useAskClaude(companyId: string | null | undefined) {
  const navigate = useNavigate();
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? ""),
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId),
    staleTime: 60_000,
  });
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession(), retry: false, staleTime: 60_000 });
  const agent = pickChatAgent(agents.data ?? []);
  // The same value the chat page puts in its draft key (IssueDetail's
  // currentUserId), including "null" for a local board without sign-in; the
  // key must match or the chat opens empty.
  const userId = String(session.data?.user?.id ?? session.data?.session?.userId ?? null);
  const ask = useCallback(
    (text: string) => {
      if (!companyId || !agent) return false;
      openChatWithDraft(navigate, { companyId, userId, agent, text });
      return true;
    },
    [companyId, agent, userId, navigate],
  );
  return { agent, ready: Boolean(companyId && agent), ask };
}
