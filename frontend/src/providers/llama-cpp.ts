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

const llamaCapabilitiesForProfile = (profile: ProviderProfileMetadata): ModelCapabilities => profile.runtime === "llama-once"
  ? { ...LLAMA_CPP_CAPABILITIES, streaming: false, tools: false, vision: false, reasoning: false, attachments: false, usage: false, abort: false }
  : LLAMA_CPP_CAPABILITIES;

export const llamaCppAdapter: ProviderAdapter = createProviderAdapter(
  "llama-cpp",
  LLAMA_CPP_CAPABILITIES,
  (profile: ProviderProfileMetadata) => profile.runtime === "llama-endpoint" || profile.runtime === "llama-once" || ["llama", "llama-cpp", "llama.cpp"].includes(String(profile.providerId ?? profile.modelInfo?.providerId ?? "").toLowerCase()),
  llamaCapabilitiesForProfile,
);
