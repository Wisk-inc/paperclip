import { useQuery } from "@tanstack/react-query";
import { deviceFilesApi } from "../api/deviceFiles";
import { queryKeys } from "../lib/queryKeys";

/** Pending file requests agents are waiting on, for nav badges. */
export function useDeviceFilesBadge(companyId: string | null | undefined) {
  const { data } = useQuery({
    queryKey: queryKeys.deviceFiles.overview(companyId ?? "none"),
    queryFn: () => deviceFilesApi.overview(companyId!),
    enabled: !!companyId,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  return { pendingRequests: data?.pendingRequestCount ?? 0, overview: data ?? null };
}
