import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { PiPromptAgentRuntime } from "../src/agent/agent-runtime";
import { toPromptAgentModel } from "../src/providers/proxy-model";

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
