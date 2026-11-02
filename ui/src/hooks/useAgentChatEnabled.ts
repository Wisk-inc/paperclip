import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Whether Agent Chat is on, from the server's experimental settings.
 *
 * `enabled` is true only when the server said so. A request that failed is
 * not the server saying "off": `failed` marks it (when no earlier answer is
 * cached), so a page can offer Try again instead of telling the person the
 * feature is switched off.
 */
export function useAgentChatEnabled() {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const failed = query.isError && query.data === undefined;
  return {
    enabled: query.data?.enableAgentChat === true,
    loaded: query.isFetched,
    failed,
    errorMessage: failed ? (query.error instanceof Error ? query.error.message : "The server didn't answer.") : null,
    retry: () => void query.refetch(),
  };
}
