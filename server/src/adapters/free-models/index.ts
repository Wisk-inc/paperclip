import { FREE_MODELS_ADAPTER_TYPE } from "@paperclipai/shared";
import type { ServerAdapterModule } from "../types.js";
import { listFreeModels } from "../../services/free-models.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const freeModelsAdapter: ServerAdapterModule = {
  type: FREE_MODELS_ADAPTER_TYPE,
  runtimeToolDelivery: "invocation_context",
  supportsLocalAgentJwt: true,
  execute,
  testEnvironment,
  models: listFreeModels(),
  agentConfigurationDoc: `# free_models agent configuration

Adapter: free_models

Free chat and image models. No API key; replies are posted to the conversation.

Core fields:
- model (string, optional): default nvidia/nemotron-3-ultra-550b-a55b:free. Image models (@cf/...) reply with a picture.
- effort (string, optional): thinking level for chat models: low, medium, high or xhigh.
`,
};
