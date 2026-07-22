import type { ModelCapabilities } from "./capabilities";
import { createProviderAdapter, type ProviderAdapter, type ProviderProfileMetadata } from "./adapter";

export const LLAMA_CPP_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  reasoning: true,
  attachments: true,
  systemPrompt: true,
  usage: true,
  abort: true,
};

export const llamaCppAdapter: ProviderAdapter = createProviderAdapter(
  "llama-cpp",
  LLAMA_CPP_CAPABILITIES,
  (profile: ProviderProfileMetadata) => profile.runtime === "llama-once" || ["llama", "llama-cpp", "llama.cpp"].includes(String(profile.providerId ?? "").toLowerCase()),
);
