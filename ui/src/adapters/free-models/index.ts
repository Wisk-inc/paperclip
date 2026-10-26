import { parseAcpxStdoutLine } from "@paperclipai/adapter-utils/acpx-engine/ui";
import { FREE_MODELS_ADAPTER_TYPE } from "@paperclipai/shared";
import type { UIAdapterModule } from "../types";

export const freeModelsUIAdapter: UIAdapterModule = {
  type: FREE_MODELS_ADAPTER_TYPE,
  label: "Free models",
  // The free engine streams the same acpx events as the Claude engine, so the
  // chat shows live text, thinking, and tool calls the same way.
  parseStdoutLine: parseAcpxStdoutLine,
  ConfigFields: () => null,
  buildAdapterConfig: (values) => (values.model ? { model: values.model } : {}),
};
