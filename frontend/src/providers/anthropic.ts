import type { ModelCapabilities } from "./capabilities";
import { createProviderAdapter, type ProviderAdapter, type ProviderProfileMetadata } from "./adapter";

export const ANTHROPIC_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  reasoning: true,
  attachments: true,
  systemPrompt: true,
  usage: true,
  abort: true,
};

export const anthropicAdapter: ProviderAdapter = createProviderAdapter(
  "anthropic",
  ANTHROPIC_CAPABILITIES,
  (profile: ProviderProfileMetadata) => {
    const providerId = String(profile.providerId ?? profile.modelInfo?.providerId ?? "").toLowerCase();
    return providerId === "anthropic" || profile.protocol === "anthropic-native" || String(profile.endpoint ?? "").toLowerCase().includes("anthropic.com");
  },
);
