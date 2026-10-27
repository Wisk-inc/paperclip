import type { QueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Show an agent change the moment it is tapped: the agent list and detail in
 * the query cache get the patch now, and the server's answer replaces it when
 * it arrives. A switch that only moved once the round trip finished read as a
 * tap that did nothing on a phone connection.
 *
 * `adapterConfig` is merged into the existing config, the way the server
 * merges it; every other field replaces.
 */
export function patchAgentCache(
  client: QueryClient,
  agentId: string,
  companyId: string,
  patch: Partial<Omit<Agent, "adapterConfig">> & { adapterConfig?: Record<string, unknown> },
): void {
  const apply = (agent: Agent): Agent => {
    if (agent.id !== agentId) return agent;
    const { adapterConfig, ...rest } = patch;
    return {
      ...agent,
      ...rest,
      ...(adapterConfig ? { adapterConfig: { ...((agent.adapterConfig as Record<string, unknown> | undefined) ?? {}), ...adapterConfig } } : {}),
    } as Agent;
  };
  client.setQueryData<Agent[]>(queryKeys.agents.list(companyId), (agents) => (agents ? agents.map(apply) : agents));
  client.setQueryData<Agent>(queryKeys.agents.detail(agentId), (agent) => (agent ? apply(agent) : agent));
}
