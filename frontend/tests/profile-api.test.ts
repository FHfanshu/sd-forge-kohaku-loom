import { afterEach, describe, expect, it, vi } from "vitest";
import { importProfiles, listModels, listProfileModels } from "../src/profile-api";

afterEach(() => vi.unstubAllGlobals());

const modelState = {
  version: 1,
  models: [{
    id: "remote",
    modelId: "model",
    displayName: "Remote",
    enabled: true,
    protocol: "openai-chat-completions",
    runtime: "remote-http",
    hasApiKey: true,
    capabilities: { tools: true },
    modelInfo: {
      source: "",
      providerId: "",
      matchedModelId: "",
      contextLimit: 0,
      outputLimit: 0,
      temperatureSupported: true,
      reasoningToggle: false,
      reasoningEfforts: [],
      syncedAt: "",
    },
    localModelConfigured: false,
    mmprojConfigured: false,
    llamaServerConfigured: false,
  }],
};

describe("profile API endpoints", () => {
  it("reads safe model metadata from the collection and profile routes", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(modelState), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listModels()).resolves.toEqual(modelState);
    await expect(listProfileModels("remote/profile")).resolves.toEqual(modelState);
    expect(fetchMock.mock.calls[0][0]).toBe("/prompt-agent/api/models");
    expect(fetchMock.mock.calls[1][0]).toBe("/prompt-agent/api/profiles/remote%2Fprofile/models");
  });

  it("posts legacy snapshots only to the explicit import endpoint", async () => {
    const state = {
      version: 1,
      profiles: [{
        id: "remote",
        model_id: "model",
        display_name: "Remote",
        protocol: "openai-chat-completions",
        runtime: "remote-http",
        endpoint: "https://provider.invalid/v1",
      }],
    };
    const responseState = {
      version: 2,
      activeProfileId: "remote",
      teacherProfileId: "remote",
      sessionProfileId: "",
      namingProfileId: "",
      profiles: [{
        id: "remote",
        displayName: "Remote",
        modelId: "model",
        enabled: true,
        protocol: "openai-chat-completions",
        runtime: "remote-http",
        endpoint: "https://provider.invalid/v1",
        fallbackEndpoints: [],
        hasApiKey: false,
       capabilities: { tools: true, vision: true, streaming: true, reasoning: true, attachments: true, systemPrompt: true, usage: true, abort: true },
        parameters: { temperature: 0.25, topP: 0.9, maxTokens: 8192, reasoningEffort: "low", timeout: 180, sanitizeSensitive: true, teacherMode: "qwen-redact" },
        modelInfo: modelState.models[0].modelInfo,
        localModelConfigured: false,
        mmprojConfigured: false,
        llamaServerConfigured: false,
        nCtx: 131072,
        nGpuLayers: -1,
        thinking: false,
      }],
    };
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(responseState), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(importProfiles(state)).resolves.toEqual(responseState);
    expect(fetchMock).toHaveBeenCalledWith("/prompt-agent/api/profiles/import", expect.objectContaining({
      method: "POST",
      body: JSON.stringify(state),
    }));
  });
});
