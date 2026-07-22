import type { ProviderAdapter, ProviderProfileMetadata } from "./adapter";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { geminiAdapter } from "./gemini";
import { llamaCppAdapter } from "./llama-cpp";
import { openAICompatibleAdapter } from "./openai-compatible";

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Provider adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ProviderAdapter {
    const adapter = this.adapters.get(normalizeProviderId(id));
    if (!adapter) throw new Error(`Unknown provider adapter: ${id}`);
    return adapter;
  }

  resolve(profile: ProviderProfileMetadata): ProviderAdapter {
    const explicit = String(profile.providerId ?? "").trim();
    if (explicit) {
      const normalized = normalizeProviderId(explicit);
      if (this.adapters.has(normalized)) return this.adapters.get(normalized)!;
      throw new Error(`Unknown provider adapter: ${explicit}`);
    }
    const adapter = this.list().find((candidate) => candidate.matches(profile));
    if (!adapter) throw new Error("No provider adapter matches the selected profile.");
    return adapter;
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}

export const normalizeProviderId = (id: string): string => ({
  openai: "openai-compatible",
  "openai-chat-completions": "openai-compatible",
  "openai_compatible": "openai-compatible",
  openrouter: "openai-compatible",
  google: "gemini",
  llama: "llama-cpp",
  "llama.cpp": "llama-cpp",
}[id.trim().toLowerCase()] ?? id.trim().toLowerCase());

export const providerRegistry = new ProviderRegistry();
providerRegistry.register(openAICompatibleAdapter);
providerRegistry.register(geminiAdapter);
providerRegistry.register(llamaCppAdapter);

export const createProviderStream = (profile: ProviderProfileMetadata & { id: string }): StreamFn =>
  providerRegistry.resolve(profile).createStream(profile.id);
