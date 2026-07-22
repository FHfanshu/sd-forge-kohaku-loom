import { describe, expect, it } from "vitest";
import { normalizeProfile, normalizeProfileState, toHostProfilePatch } from "../src/profile-adapter";

describe("profile migration adapters", () => {
  it("collapses removed provider modes without turning resident endpoints into one-shot models", () => {
    expect(normalizeProfile({
      id: "legacy-endpoint",
      modelId: "local-model",
      protocol: "openai-chat-completions",
      runtime: "llama-endpoint",
    })).toMatchObject({ protocol: "openai-chat-completions", runtime: "remote-http" });
    expect(normalizeProfile({
      id: "legacy-anthropic",
      modelId: "claude",
      protocol: "anthropic-native",
      runtime: "remote-http",
    })).toMatchObject({ protocol: "openai-chat-completions", runtime: "remote-http" });
  });

  it("maps legacy snake_case profile fields into the Svelte contract", () => {
    const profile = normalizeProfile({
      id: "legacy-local",
      display_name: "Legacy local",
      model: "qwen3.5-9b-vlm",
      protocol: "openai-chat-completions",
      runtime: "llama-once",
      endpoint: "http://127.0.0.1:8080/v1/",
      fallback_endpoints: ["http://backup.local/v1"],
      has_api_key: true,
      capabilities: { tools: true, vision: true, streaming: true, reasoning: false },
      parameters: { temperature: 0.4, top_p: 0.8, max_tokens: 2048, reasoning_effort: "none", timeout: 90, sanitize_sensitive: false },
      local_model_configured: true,
      mmproj_configured: true,
      llama_server_configured: true,
      n_ctx: 8192,
      n_gpu_layers: 12,
      thinking: true,
    });

    expect(profile).toMatchObject({
      id: "legacy-local",
      displayName: "Legacy local",
      modelId: "qwen3.5-9b-vlm",
      endpoint: "http://127.0.0.1:8080/v1",
      hasApiKey: true,
      localModelConfigured: true,
      mmprojConfigured: true,
      llamaServerConfigured: true,
      nCtx: 8192,
      nGpuLayers: 12,
      idleUnloadMinutes: 30,
      parameters: { topP: 0.8, maxTokens: 2048, sanitizeSensitive: false },
    });
  });

  it("preserves route constraints while normalizing a version-one state", () => {
    const state = normalizeProfileState({
      version: 1,
      active_profile_id: "disabled",
      session_profile_id: "deepseek",
      naming_profile_id: "local-qwen-once",
      profiles: [
        { id: "disabled", display_name: "Disabled", model_id: "disabled", enabled: false, runtime: "remote-http", protocol: "openai-chat-completions" },
        { id: "grok", display_name: "Grok", model_id: "grok", enabled: true, runtime: "remote-http", protocol: "openai-chat-completions" },
        { id: "local-qwen-once", display_name: "Local", model_id: "qwen", enabled: true, runtime: "llama-once", protocol: "openai-chat-completions", local_model_configured: true },
      ],
    });

    expect(state.activeProfileId).toBe("grok");
    expect(state.sessionProfileId).toBe("local-qwen-once");
    expect(state.namingProfileId).toBe("local-qwen-once");
  });

  it("serializes nested Svelte patches for the host facade", () => {
  expect(toHostProfilePatch({ parameters: { topP: 0.7, maxTokens: 4096 }, modelInfo: { providerId: "openai" }, capabilities: { vision: false } })).toEqual({
      parameters: { top_p: 0.7, max_tokens: 4096 },
      model_info: { provider_id: "openai" },
      capabilities: { vision: false },
    });
  });

  it("normalizes resident local runtime idle unloading", () => {
    const profile = normalizeProfile({
      id: "local",
      runtime: "llama-once",
      protocol: "openai-chat-completions",
      modelId: "gemma",
      idle_unload_minutes: 0,
    });

    expect(profile.unloadAfterTurn).toBe(false);
    expect(profile.idleUnloadMinutes).toBe(0);
    expect(toHostProfilePatch({ idleUnloadMinutes: 45 })).toEqual({ idle_unload_minutes: 45 });
  });

  it("keeps local paths write-only", () => {
    const profile = normalizeProfile({
      id: "local",
      displayName: "Local",
      modelId: "model",
      runtime: "llama-once",
      protocol: "openai-chat-completions",
      modelPath: "C:/private/model.gguf",
      localModelConfigured: true,
    });

    expect(profile.localModelConfigured).toBe(true);
    expect(profile).not.toHaveProperty("modelPath");
    expect(toHostProfilePatch({ modelPath: "C:/private/model.gguf" })).toEqual({ model_path: "C:/private/model.gguf" });
  });
});
