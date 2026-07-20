import type { ModelCapabilities } from "./capabilities";
import { createProviderAdapter, type ProviderAdapter, type ProviderProfileMetadata } from "./adapter";

export const OPENROUTER_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  reasoning: true,
  attachments: true,
  systemPrompt: true,
  usage: true,
  abort: true,
};

export const openRouterAdapter: ProviderAdapter = createProviderAdapter(
  "openrouter",
  OPENROUTER_CAPABILITIES,
  (profile: ProviderProfileMetadata) => {
    const providerId = String(profile.providerId ?? profile.modelInfo?.providerId ?? "").toLowerCase();
    return providerId === "openrouter" || String(profile.endpoint ?? "").toLowerCase().includes("openrouter.ai");
  },
);
