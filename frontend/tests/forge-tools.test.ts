import { Compile } from "typebox/compile";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { PiPromptAgentRuntime } from "../src/agent/agent-runtime";
import { FORGE_TOOL_SCHEMAS, ForgeToolError, createForgeAgentTools } from "../src/tools/forge-tools";
import { toPromptAgentModel } from "../src/providers/proxy-model";

const TOOL_NAMES = [
  "read_prompt",
  "edit_prompt",
  "read_negative_prompt",
  "edit_negative_prompt",
  "list_resources",
  "read_resource_metadata",
  "ask_teacher",
  "read_generation_parameters",
  "apply_generation_parameters",
  "list_models",
  "list_loras",
  "list_embeddings",
] as const;

function host(result: unknown = { ok: true, value: "done" }) {
  const calls: Array<{ tool: string; arguments: Record<string, unknown>; signal?: AbortSignal }> = [];
  return {
    calls,
    api: {
      name: "prompt-agent-host" as const,
      version: "1.0.0" as const,
      apiVersion: 1 as const,
      capabilities: ["forge-availability", "prompt-target", "tool-execution"] as const,
      handshake: () => ({ ok: true as const, bridge: "prompt-agent-ui" as const, apiVersion: 1 as const, version: "1.0.0" as const, capabilities: [] }),
      isForgeAvailable: () => true,
      activePromptTarget: () => "txt2img",
      readPrompt: async () => result,
      captureForgeState: () => ({}),
      restoreForgeState: () => true,
      executeTool: async (value: unknown, signal?: AbortSignal) => {
        calls.push({ tool: String((value as { tool?: string }).tool), arguments: ((value as { arguments?: Record<string, unknown> }).arguments ?? {}), signal });
        return result;
      },
      executeAssistantTool: async (value: unknown, signal?: AbortSignal) => {
        calls.push({ tool: String((value as { tool?: string }).tool), arguments: ((value as { arguments?: Record<string, unknown> }).arguments ?? {}), signal });
        return result;
      },
      openSettings: () => undefined,
      getLocaleHints: () => ({ locale: "en" }),
      subscribeLocaleHints: () => () => undefined,
    },
  };
}

describe("Forge Agent Tools", () => {
  it("exports all Phase 6 tools in roadmap order with TypeBox schemas and permissions", () => {
    const tools = createForgeAgentTools({ host: () => host().api });
    const samples = {
      read_prompt: {},
      edit_prompt: { base_hash: "hash" },
      read_negative_prompt: {},
      edit_negative_prompt: { base_hash: "hash" },
      list_resources: { kind: "style" },
      read_resource_metadata: { kind: "style", id: "style" },
      ask_teacher: { question: "question" },
      read_generation_parameters: {},
      apply_generation_parameters: { context_hash: "hash", parameters: {} },
      list_models: {},
      list_loras: {},
      list_embeddings: {},
    } as const;
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    for (const name of TOOL_NAMES) {
      expect(FORGE_TOOL_SCHEMAS[name]).toBeDefined();
      expect(Compile(FORGE_TOOL_SCHEMAS[name]).Check(samples[name])).toBe(true);
    }
    expect(tools.filter((tool) => tool.permission === "write").map((tool) => tool.name)).toEqual([
      "edit_prompt",
      "edit_negative_prompt",
      "apply_generation_parameters",
    ]);
    expect(JSON.stringify(tools)).not.toMatch(/claim|release|bridge_id|lease|owner_id/i);
  });

  it("performs one host request for read and guarded edit", async () => {
    const fake = host({ ok: true, prompt: "portrait", prompt_hash: "hash-1" });
    const tools = createForgeAgentTools({ host: () => fake.api });
    const read = tools.find((tool) => tool.name === "read_prompt")!;
    const edit = tools.find((tool) => tool.name === "edit_prompt")!;

    const readResult = await read.execute("read-1", {}, new AbortController().signal);
    await edit.execute("edit-1", { base_hash: "hash-1", patches: [{ operation: "append", text: "light" }] }, new AbortController().signal);

    expect(readResult.details).toMatchObject({ ok: true, prompt_hash: "hash-1" });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]).toMatchObject({ tool: "edit_prompt", arguments: { base_hash: "hash-1", field: "positive" } });
  });

  it("throws a user-readable structured error for stale hashes", async () => {
    const fake = host({ ok: false, error: "prompt changed since read_prompt; read again" });
    const edit = createForgeAgentTools({ host: () => fake.api }).find((tool) => tool.name === "edit_prompt")!;

    await expect(edit.execute("edit-1", { base_hash: "stale", patches: [{ operation: "append", text: "x" }] }, new AbortController().signal))
      .rejects.toMatchObject({ code: "forge_tool_failed", message: "prompt changed since read_prompt; read again" } satisfies Partial<ForgeToolError>);
  });

  it("terminates on timeout and forwards abort", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fake = host();
    fake.api.executeAssistantTool = async (_value: unknown, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      return { ok: false, error: "cancelled" };
    };
    const tool = createForgeAgentTools({ host: () => fake.api, timeoutMs: 1_000 }).find((item) => item.name === "read_prompt")!;
    const pending = tool.execute("read-1", {}, new AbortController().signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "forge_tool_timeout" });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(aborted).toBe(true);
    vi.useRealTimers();
  });

  it("rejects writes at the permission boundary", async () => {
    const fake = host();
    const edit = createForgeAgentTools({ host: () => fake.api, allowWrites: () => false }).find((tool) => tool.name === "edit_prompt")!;

    await expect(edit.execute("edit-1", { base_hash: "hash", patches: [{ operation: "append", text: "x" }] }, new AbortController().signal))
      .rejects.toMatchObject({ code: "permission_denied" });
    expect(fake.calls).toHaveLength(0);
  });

  it("does not block a later submission after a failed tool", async () => {
    const model = toPromptAgentModel({
      id: "tool-model",
      providerId: "test",
      displayName: "Tool test",
      capabilities: { streaming: true, tools: true, vision: false, reasoning: false, attachments: false, systemPrompt: true },
      contextWindow: 8192,
      maxTokens: 1024,
    });
    let turn = 0;
    const stream: StreamFn = (activeModel) => {
      const output = createAssistantMessageEventStream();
      const message = turn++ === 0
        ? { role: "assistant" as const, content: [{ type: "toolCall" as const, id: "call-1", name: "read_prompt", arguments: {} }], api: activeModel.api, provider: activeModel.provider, model: activeModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" as const, timestamp: Date.now() }
        : { role: "assistant" as const, content: [{ type: "text" as const, text: "recovered" }], api: activeModel.api, provider: activeModel.provider, model: activeModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() };
      queueMicrotask(() => {
        output.push({ type: "start", partial: { ...message, content: [] } });
        output.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
        output.end();
      });
      return output;
    };
    const tools = createForgeAgentTools({ host: () => host({ ok: false, error: "failed tool" }).api });
    const runtime = new PiPromptAgentRuntime({ model, streamFn: stream, tools });

    await runtime.submit({ text: "first" });
    expect(runtime.getState().status).toBe("completed");
    await runtime.submit({ text: "second" });
    expect(runtime.getState().status).toBe("completed");
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant" });
    runtime.destroy();
  });
});
