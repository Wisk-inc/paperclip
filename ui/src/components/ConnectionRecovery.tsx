import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { startConnectionRecovery } from "@/lib/connection-recovery";

/** Makes failed requests again by themselves once the connection is back (see startConnectionRecovery). */
export function ConnectionRecovery() {
  const queryClient = useQueryClient();
  useEffect(() => startConnectionRecovery(queryClient), [queryClient]);
  return null;
}
