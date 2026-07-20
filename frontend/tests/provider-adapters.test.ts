import { createProviderStream, providerRegistry } from "../src/providers/registry";
import type { ProviderProfileMetadata } from "../src/providers/adapter";
import { toPromptAgentModel } from "../src/providers/proxy-model";

const encoder = new TextEncoder();
const capabilities = { streaming: true, tools: true, vision: true, reasoning: true, attachments: true, systemPrompt: true, usage: true, abort: true };
const profiles: Array<ProviderProfileMetadata & { id: string; expected: string }> = [
  { id: "openai-profile", expected: "openai-compatible", protocol: "openai-chat-completions", runtime: "remote-http", endpoint: "https://provider.invalid/v1" },
  { id: "router-profile", expected: "openrouter", providerId: "openrouter", protocol: "openai-chat-completions", runtime: "remote-http", endpoint: "https://openrouter.ai/api/v1" },
  { id: "anthropic-profile", expected: "anthropic", protocol: "anthropic-native", runtime: "remote-http", endpoint: "https://api.anthropic.com/v1" },
  { id: "gemini-profile", expected: "gemini", protocol: "gemini-native", runtime: "remote-http", endpoint: "https://generativelanguage.googleapis.com" },
  { id: "llama-profile", expected: "llama-cpp", protocol: "openai-chat-completions", runtime: "llama-endpoint", endpoint: "http://127.0.0.1:8080/v1" },
];

function response(...events: unknown[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("provider adapter registry", () => {
  it("resolves all Phase 5 providers to proxy-only adapters", () => {
    expect(providerRegistry.list().map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "openrouter",
      "anthropic",
      "gemini",
      "llama-cpp",
    ]);
    for (const profile of profiles) expect(providerRegistry.resolve(profile).id).toBe(profile.expected);
    expect(() => providerRegistry.resolve({ providerId: "unsupported-provider", protocol: "openai-chat-completions" })).toThrow("Unknown provider adapter");
  });

  it("makes profile-declared unsupported capabilities explicit", () => {
    const adapter = providerRegistry.get("openai-compatible");
    const profile = { protocol: "openai-chat-completions", runtime: "remote-http", capabilities: { ...capabilities, tools: false } };
    expect(adapter.effectiveCapabilities(profile).tools).toBe(false);
    expect(adapter.unsupportedCapabilities(profile)).toContain("tools");
    expect(providerRegistry.get("llama-cpp").unsupportedCapabilities({ runtime: "llama-once" })).toEqual(expect.arrayContaining(["streaming", "tools", "abort"]));
  });

  it("returns the shared proxy StreamFn and never needs provider credentials", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return response(
        { type: "start" },
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "Hello" },
        { type: "text_end", contentIndex: 0 },
        { type: "done", reason: "stop" },
      );
    };
    vi.stubGlobal("fetch", fetchImpl);
    const stream = createProviderStream({ id: "anthropic-profile", protocol: "anthropic-native", runtime: "remote-http", endpoint: "https://api.anthropic.com/v1" });
    const model = toPromptAgentModel({ id: "claude", providerId: "anthropic", displayName: "Claude", capabilities, contextWindow: 8192, maxTokens: 1024 });
    const result = await (await stream(model, { messages: [{ role: "user", content: "Hi", timestamp: 1 }] }, {})).result();
    expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(body.profile_id).toBe("anthropic-profile");
    expect(JSON.stringify(body)).not.toMatch(/apiKey|api_key|endpoint|modelPath|headers/);
    vi.unstubAllGlobals();
  });

  it("propagates cancellation through the shared proxy stream", async () => {
    let aborted = false;
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (_input, init) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      await new Promise<void>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      throw new DOMException("Aborted", "AbortError");
    };
    const stream = (await import("../src/providers/proxy-stream")).createPromptAgentStream(() => "profile", "/prompt-agent/api/stream", fetchImpl);
    const model = toPromptAgentModel({ id: "model", providerId: "openai-compatible", displayName: "Model", capabilities, contextWindow: 8192, maxTokens: 1024 });
    const resultPromise = (await stream(model, { messages: [{ role: "user", content: "Hi", timestamp: 1 }] }, { signal: controller.signal })).result();
    controller.abort();
    const result = await resultPromise;
    expect(aborted).toBe(true);
    expect(result.stopReason).toBe("aborted");
  });
});
