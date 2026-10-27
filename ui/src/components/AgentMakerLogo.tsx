import { pairedFreeImageModel, type Agent } from "@paperclipai/shared";
import { BondedModelLogos } from "@/components/BondedModelLogos";
import { ModelLogo } from "@/components/ModelLogo";

/**
 * The maker's logo for the model an agent runs on, so a list of agents shows
 * at a glance who answers for each: the Claude star, the DeepSeek whale, and
 * for a free agent paired with an image model, the two logos together.
 */
export function AgentMakerLogo({
  agent,
  size = "xs",
  className,
}: {
  agent: Pick<Agent, "adapterType" | "adapterConfig">;
  size?: "xs" | "sm";
  className?: string;
}) {
  const model = typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : "";
  const paired = agent.adapterType === "free_models" && model && !model.startsWith("@cf/") ? pairedFreeImageModel(agent.adapterConfig) : "";
  if (paired) {
    return <BondedModelLogos chatModelId={model} imageModelId={paired} size={size} tile={false} className={className} />;
  }
  return <ModelLogo modelId={model} adapterType={agent.adapterType} size={size} tile={false} className={className} />;
}
