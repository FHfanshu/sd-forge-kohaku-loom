import type { ModelCapabilities } from "./capabilities";
import { createProviderAdapter, type ProviderAdapter, type ProviderProfileMetadata } from "./adapter";

export const GEMINI_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  reasoning: true,
  attachments: true,
  systemPrompt: true,
  usage: true,
  abort: true,
};

export const geminiAdapter: ProviderAdapter = createProviderAdapter(
  "gemini",
  GEMINI_CAPABILITIES,
  (profile: ProviderProfileMetadata) => {
    const providerId = String(profile.providerId ?? profile.modelInfo?.providerId ?? "").toLowerCase();
    const endpoint = String(profile.endpoint ?? "").toLowerCase();
    return providerId === "gemini" || providerId === "google" || profile.protocol === "gemini-native" || endpoint.includes("generativelanguage.googleapis.com");
  },
);
