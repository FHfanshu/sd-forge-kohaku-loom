import type { Model } from "@earendil-works/pi-ai";
import type { ProviderModel } from "./adapter";

export const toPromptAgentModel = (model: ProviderModel): Model<any> => ({
  id: model.id,
  name: model.displayName,
  api: "prompt-agent-proxy",
  provider: model.providerId,
  baseUrl: "/prompt-agent/api",
  reasoning: model.capabilities.reasoning,
  input: model.capabilities.vision ? ["text", "image"] : ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
});
