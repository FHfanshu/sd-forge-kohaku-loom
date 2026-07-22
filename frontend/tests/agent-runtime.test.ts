import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { PiPromptAgentRuntime } from "../src/agent/agent-runtime";
import { toPromptAgentModel } from "../src/providers/proxy-model";
import { acceptanceTest } from "./acceptance";

const model = toPromptAgentModel({
  id: "test-model",
  providerId: "test",
  displayName: "Test",
  capabilities: { streaming: true, tools: false, vision: false, reasoning: false, attachments: false, systemPrompt: true },
  contextWindow: 8192,
  maxTokens: 1024,
});

const successfulStream: StreamFn = (activeModel) => {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Hello" }],
    api: activeModel.api,
    provider: activeModel.provider,
    model: activeModel.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
  });
  return stream;
};

const failedStream: StreamFn = (activeModel) => {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "" }],
    api: activeModel.api,
    provider: activeModel.provider,
    model: activeModel.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error" as const,
    errorMessage: "provider unavailable",
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "error", reason: "error", error: message });
    stream.end();
  });
  return stream;
};

function abortableStream(onAbort: () => void): StreamFn {
  return (activeModel, _context, options = {}) => {
    const stream = createAssistantMessageEventStream();
    const partial = {
      role: "assistant" as const,
      content: [] as Array<{ type: "text"; text: string }>,
      api: activeModel.api,
      provider: activeModel.provider,
      model: activeModel.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    queueMicrotask(() => stream.push({ type: "start", partial }));
    const finishAbort = () => {
      onAbort();
      const error = { ...partial, stopReason: "aborted" as const, errorMessage: "Request aborted" };
      stream.push({ type: "error", reason: "aborted", error });
      stream.end();
    };
    if (options.signal?.aborted) queueMicrotask(finishAbort);
    else options.signal?.addEventListener("abort", finishAbort, { once: true });
    return stream;
  };
}

function streamMessage(activeModel: typeof model, content: any[], reason: "stop" | "toolUse" = "stop") {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant" as const,
    content,
    api: activeModel.api,
    provider: activeModel.provider,
    model: activeModel.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: reason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason, message });
    stream.end();
  });
  return stream;
}

describe("PiPromptAgentRuntime", () => {
  it("owns the transcript and reaches completed state", async () => {
    const runtime = new PiPromptAgentRuntime({ model, streamFn: successfulStream });
    const statuses: string[] = [];
    runtime.subscribe((state) => statuses.push(state.status));
    await runtime.submit({ text: "Hi" });
    expect(runtime.getMessages().map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(runtime.getState().status).toBe("completed");
    expect(statuses).toContain("submitting");
    runtime.destroy();
  });

  it("rejects use after destroy", async () => {
    const runtime = new PiPromptAgentRuntime({ model, streamFn: successfulStream });
    runtime.destroy();
    await expect(runtime.submit({ text: "Hi" })).rejects.toThrow("destroyed");
  });

  it("produces a terminal failed state when the provider fails", async () => {
    const runtime = new PiPromptAgentRuntime({ model, streamFn: failedStream });

    await runtime.submit({ text: "Hi" });

    expect(runtime.getState()).toMatchObject({
      status: "failed",
      error: { code: "provider_error", message: "provider unavailable" },
    });
    runtime.destroy();
  });

  it("replaces the transcript while idle for edit-and-resend", () => {
    const runtime = new PiPromptAgentRuntime({
      model,
      streamFn: successfulStream,
      messages: [
        { role: "user", content: "Original", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Old reply" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: 2,
        },
      ],
    });

    runtime.replaceMessages([{ role: "user", content: "Earlier context", timestamp: 3 }]);

    expect(runtime.getMessages()).toEqual([{ role: "user", content: "Earlier context", timestamp: 3 }]);
    expect(runtime.getState().status).toBe("idle");
    runtime.destroy();
  });

  it("injects bounded corrective follow-ups until a requested prompt edit succeeds", async () => {
    let call = 0;
    const contexts: any[] = [];
    const editPrompt: AgentTool<any> = {
      name: "edit_prompt",
      label: "Edit prompt",
      description: "Edit prompt",
      parameters: Type.Object({ base_hash: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    };
    const streamFn: StreamFn = (activeModel, context) => {
      contexts.push(context);
      call += 1;
      if (call === 1) return streamMessage(activeModel as typeof model, [{ type: "text", text: "Here is some advice instead." }]);
      if (call === 2) return streamMessage(activeModel as typeof model, [{ type: "toolCall", id: "edit-1", name: "edit_prompt", arguments: { base_hash: "fresh" } }], "toolUse");
      return streamMessage(activeModel as typeof model, [{ type: "text", text: "Prompt updated." }]);
    };
    const runtime = new PiPromptAgentRuntime({ model, streamFn, tools: [editPrompt] });

    await runtime.submit({ text: "Rewrite the current prompt", requirePromptMutation: true });

    expect(call).toBe(3);
    expect(contexts[1].messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("no edit_prompt call has succeeded"),
    });
    expect(runtime.getMessages().some((message) => message.role === "promptAgentControl")).toBe(false);
    expect(runtime.getMessages().some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text.includes("advice instead")))).toBe(false);
    expect(runtime.getState()).toMatchObject({ status: "completed", error: undefined });

    await runtime.submit({ text: "Summarize the result" });
    expect(contexts[3].messages.some((message: any) => (
      message.role === "user" && typeof message.content === "string" && message.content.includes("no edit_prompt call has succeeded")
    ))).toBe(false);
    runtime.destroy();
  });

  acceptanceTest("PROMPT-TOOLKIT-001@1", "toolkit-before-write", "blocks deterministic prompt cleanup writes until prompt_toolkit succeeds", async () => {
    let call = 0;
    const executed: string[] = [];
    const editPrompt: AgentTool<any> = {
      name: "edit_prompt",
      label: "Edit prompt",
      description: "Edit prompt",
      parameters: Type.Object({ base_hash: Type.String() }),
      execute: async () => {
        executed.push("edit_prompt");
        return { content: [{ type: "text", text: "edited" }], details: { ok: true } };
      },
    };
    const promptToolkit: AgentTool<any> = {
      name: "prompt_toolkit",
      label: "Prompt toolkit",
      description: "Normalize prompt deterministically",
      parameters: Type.Object({ action: Type.String(), prompt: Type.String() }),
      execute: async () => {
        executed.push("prompt_toolkit");
        return { content: [{ type: "text", text: "analyzed" }], details: { ok: true } };
      },
    };
    const streamFn: StreamFn = (activeModel) => {
      call += 1;
      if (call === 1) return streamMessage(activeModel as typeof model, [{ type: "toolCall", id: "edit-too-early", name: "edit_prompt", arguments: { base_hash: "fresh" } }], "toolUse");
      if (call === 2) return streamMessage(activeModel as typeof model, [{ type: "toolCall", id: "toolkit-1", name: "prompt_toolkit", arguments: { action: "sort", prompt: "1girl, blue eyes" } }], "toolUse");
      if (call === 3) return streamMessage(activeModel as typeof model, [{ type: "toolCall", id: "edit-allowed", name: "edit_prompt", arguments: { base_hash: "fresh" } }], "toolUse");
      return streamMessage(activeModel as typeof model, [{ type: "text", text: "Prompt sorted." }]);
    };
    const runtime = new PiPromptAgentRuntime({ model, streamFn, tools: [editPrompt, promptToolkit] });

    await runtime.submit({ text: "Sort the current prompt tags", requirePromptMutation: true, requirePromptToolkit: true });

    expect(call).toBe(4);
    expect(executed).toEqual(["prompt_toolkit", "edit_prompt"]);
    expect(runtime.getMessages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "toolResult", toolName: "edit_prompt", isError: true }),
      expect.objectContaining({ role: "toolResult", toolName: "prompt_toolkit", isError: false }),
    ]));
    expect(runtime.getState()).toMatchObject({ status: "completed", error: undefined });
    runtime.destroy();
  });

  it("fails visibly after bounded correction when a requested prompt edit never happens", async () => {
    let call = 0;
    const streamFn: StreamFn = (activeModel) => {
      call += 1;
      return streamMessage(activeModel as typeof model, [{ type: "text", text: `Advice ${call}` }]);
    };
    const runtime = new PiPromptAgentRuntime({ model, streamFn });

    await runtime.submit({ text: "Rewrite the current prompt", requirePromptMutation: true });

    expect(call).toBe(3);
    expect(runtime.getState()).toMatchObject({
      status: "failed",
      error: { code: "prompt_mutation_incomplete" },
    });
    expect(runtime.getMessages().filter((message) => message.role === "assistant")).toEqual([]);
    runtime.destroy();
  });

  acceptanceTest("AGENT-LOOKUP-001@1", "style-first,unverified-hidden", "suppresses a direct background answer until a matching Forge style is inspected", async () => {
    let call = 0;
    const contexts: any[] = [];
    const choices: unknown[] = [];
    const searchStyles: AgentTool<any> = {
      name: "search_resources",
      label: "Search resources",
      description: "Search resources",
      parameters: Type.Object({ kind: Type.String(), query: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "style match" }], details: { ok: true, kind: "style", items: [{ id: "moqing" }] } }),
    };
    const inspectStyle: AgentTool<any> = {
      name: "inspect_resource",
      label: "Inspect resource",
      description: "Inspect resource",
      parameters: Type.Object({ kind: Type.String(), id: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "trigger words" }], details: { ok: true, kind: "style", id: "moqing" } }),
    };
    const streamFn: StreamFn = (activeModel, context, options) => {
      contexts.push(context);
      choices.push((options as { toolChoice?: string }).toolChoice);
      call += 1;
      if (call === 1) return streamMessage(activeModel as typeof model, [{ type: "text", text: "Moqing is definitely ..." }]);
      if (call === 2) return streamMessage(activeModel as typeof model, [{ type: "toolCall", id: "search-1", name: "search_resources", arguments: { kind: "style", query: "moqing" } }], "toolUse");
      if (call === 3) return streamMessage(activeModel as typeof model, [{ type: "toolCall", id: "inspect-1", name: "inspect_resource", arguments: { kind: "style", id: "moqing" } }], "toolUse");
      return streamMessage(activeModel as typeof model, [{ type: "text", text: "The local Forge style says ..." }]);
    };
    const runtime = new PiPromptAgentRuntime({ model, streamFn, tools: [searchStyles, inspectStyle] });

    await runtime.submit({ text: "moqing 是谁？", requireBackgroundLookup: true });

    expect(call).toBe(4);
    expect(choices).toEqual(["search_resources", "search_resources", "inspect_resource", undefined]);
    expect(contexts[1].messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Forge style templates") });
    expect(runtime.getMessages().some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text.includes("definitely")))).toBe(false);
    expect(runtime.getMessages().some((message) => message.role === "toolResult")).toBe(true);
    expect(runtime.getState()).toMatchObject({ status: "completed", error: undefined });
    runtime.destroy();
  });

  acceptanceTest("AGENT-LOOKUP-001@1", "fallback", "falls back to Danbooru only when no Forge style matches", async () => {
    let call = 0;
    const choices: unknown[] = [];
    const searchStyles: AgentTool<any> = {
      name: "search_resources",
      label: "Search resources",
      description: "Search resources",
      parameters: Type.Object({ kind: Type.String(), query: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "no styles" }], details: { ok: true, kind: "style", items: [] } }),
    };
    const inspectTags: AgentTool<any> = {
      name: "inspect_danbooru_tags",
      label: "Inspect tags",
      description: "Inspect tags",
      parameters: Type.Object({ names: Type.Array(Type.String()), include_wiki: Type.Boolean() }),
      execute: async () => ({ content: [{ type: "text", text: "wiki result" }], details: { ok: true, items: [{ name: "moqing" }] } }),
    };
    const streamFn: StreamFn = (activeModel, _context, options) => {
      choices.push((options as { toolChoice?: string }).toolChoice);
      call += 1;
      if (call === 1) return streamMessage(activeModel as typeof model, [{ type: "toolCall", id: "search-1", name: "search_resources", arguments: { kind: "style", query: "moqing" } }], "toolUse");
      if (call === 2) return streamMessage(activeModel as typeof model, [{ type: "toolCall", id: "inspect-1", name: "inspect_danbooru_tags", arguments: { names: ["moqing"], include_wiki: true } }], "toolUse");
      return streamMessage(activeModel as typeof model, [{ type: "text", text: "No local style matched; Danbooru reports ..." }]);
    };
    const runtime = new PiPromptAgentRuntime({ model, streamFn, tools: [searchStyles, inspectTags] });

    await runtime.submit({ text: "moqing 是谁？", requireBackgroundLookup: true });

    expect(choices).toEqual(["search_resources", "inspect_danbooru_tags", undefined]);
    expect(runtime.getState()).toMatchObject({ status: "completed", error: undefined });
    runtime.destroy();
  });

  it("propagates abort to the active stream and reaches a terminal state", async () => {
    let aborted = false;
    const runtime = new PiPromptAgentRuntime({ model, streamFn: abortableStream(() => { aborted = true; }) });
    const submission = runtime.submit({ text: "Hi" });
    await vi.waitFor(() => expect(runtime.getState().status).not.toBe("idle"));

    runtime.abort();
    await submission;

    expect(aborted).toBe(true);
    expect(runtime.getState()).toMatchObject({ status: "failed", error: { code: "runtime_aborted" } });
    runtime.destroy();
  });

  it("destroy aborts in-flight work and removes subscribers", async () => {
    let aborted = false;
    let notifications = 0;
    const runtime = new PiPromptAgentRuntime({ model, streamFn: abortableStream(() => { aborted = true; }) });
    runtime.subscribe(() => { notifications += 1; });
    const submission = runtime.submit({ text: "Hi" });
    await vi.waitFor(() => expect(notifications).toBeGreaterThan(1));
    const beforeDestroy = notifications;

    runtime.destroy();
    await submission;

    expect(aborted).toBe(true);
    expect(notifications).toBe(beforeDestroy);
  });
});
