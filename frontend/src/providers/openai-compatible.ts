import type { ModelCapabilities } from "./capabilities";
import { createProviderAdapter, type ProviderAdapter, type ProviderProfileMetadata } from "./adapter";

export const OPENAI_COMPATIBLE_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  reasoning: true,
  attachments: true,
  systemPrompt: true,
  usage: true,
  abort: true,
};

export const openAICompatibleAdapter: ProviderAdapter = createProviderAdapter(
  "openai-compatible",
  OPENAI_COMPATIBLE_CAPABILITIES,
  (profile: ProviderProfileMetadata) => {
    const providerId = String(profile.providerId ?? profile.modelInfo?.providerId ?? "").toLowerCase();
    const endpoint = String(profile.endpoint ?? "").toLowerCase();
    return profile.runtime !== "llama-once"
      && profile.protocol !== "gemini-native"
      && providerId !== "gemini"
      && !endpoint.includes("generativelanguage.googleapis.com");
  },
);
