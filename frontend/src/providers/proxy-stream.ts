import { createAssistantMessageEventStream, parseStreamingJson } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

interface ProxyEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  id?: string;
  toolName?: string;
  reason?: "stop" | "length" | "toolUse" | "aborted" | "error";
  errorMessage?: string;
  errorCode?: string;
  usage?: Usage;
}

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export const createPromptAgentStream = (
  profileId: () => string,
  endpoint = "/prompt-agent/api/stream",
  fetchImpl: typeof fetch = fetch,
): StreamFn => (model, context, options = {}) => {
  const stream = createAssistantMessageEventStream();
  void consumeProxy(stream, model, context, options, profileId(), endpoint, fetchImpl);
  return stream;
};

async function consumeProxy(
  stream: AssistantMessageEventStream,
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions,
  profileId: string,
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  let terminal = false;
  const partialToolJson = new Map<number, string>();
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile_id: profileId,
        request_id: crypto.randomUUID(),
        context,
        options: {
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          reasoning: options.reasoning,
          sessionId: options.sessionId,
        },
      }),
      signal: options.signal,
    });
    if (!response.ok) throw new Error(await safeHttpError(response));
    if (!response.body) throw new Error("Provider proxy returned no response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) terminal ||= applyFrame(frame, partial, partialToolJson, stream);
    }
    buffer += decoder.decode();
    if (buffer.trim()) terminal ||= applyFrame(buffer, partial, partialToolJson, stream);
    if (!terminal) throw new Error("Provider proxy ended without a terminal event");
  } catch (error) {
    if (!terminal) {
      const reason = options.signal?.aborted ? "aborted" : "error";
      partial.stopReason = reason;
      partial.errorMessage = options.signal?.aborted ? "Request aborted" : error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason, error: partial });
    }
  } finally {
    stream.end();
  }
}

function applyFrame(
  frame: string,
  partial: AssistantMessage,
  partialToolJson: Map<number, string>,
  stream: AssistantMessageEventStream,
): boolean {
  const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  if (!data) return false;
  const event = applyProxyEvent(JSON.parse(data) as ProxyEvent, partial, partialToolJson);
  if (!event) return false;
  stream.push(event);
  return event.type === "done" || event.type === "error";
}

function applyProxyEvent(
  event: ProxyEvent,
  partial: AssistantMessage,
  partialToolJson: Map<number, string>,
): AssistantMessageEvent | undefined {
  const index = event.contentIndex ?? 0;
  if (event.type === "start") return { type: "start", partial };
  if (event.type === "text_start") {
    partial.content[index] = { type: "text", text: "" };
    return { type: "text_start", contentIndex: index, partial };
  }
  if (event.type === "text_delta") {
    const block = partial.content[index];
    if (block?.type !== "text") throw new Error("Received text delta before text start");
    block.text += event.delta ?? "";
    return { type: "text_delta", contentIndex: index, delta: event.delta ?? "", partial };
  }
  if (event.type === "text_end") {
    const block = partial.content[index];
    if (block?.type !== "text") throw new Error("Received text end before text start");
    return { type: "text_end", contentIndex: index, content: block.text, partial };
  }
  if (event.type === "thinking_start") {
    partial.content[index] = { type: "thinking", thinking: "" };
    return { type: "thinking_start", contentIndex: index, partial };
  }
  if (event.type === "thinking_delta") {
    const block = partial.content[index];
    if (block?.type !== "thinking") throw new Error("Received thinking delta before thinking start");
    block.thinking += event.delta ?? "";
    return { type: "thinking_delta", contentIndex: index, delta: event.delta ?? "", partial };
  }
  if (event.type === "thinking_end") {
    const block = partial.content[index];
    if (block?.type !== "thinking") throw new Error("Received thinking end before thinking start");
    return { type: "thinking_end", contentIndex: index, content: block.thinking, partial };
  }
  if (event.type === "toolcall_start") {
    partialToolJson.set(index, "");
    partial.content[index] = { type: "toolCall", id: event.id ?? `call_${index}`, name: event.toolName ?? "unknown", arguments: {} };
    return { type: "toolcall_start", contentIndex: index, partial };
  }
  if (event.type === "toolcall_delta") {
    const block = partial.content[index];
    if (block?.type !== "toolCall") throw new Error("Received tool delta before tool start");
    const nextJson = `${partialToolJson.get(index) ?? ""}${event.delta ?? ""}`;
    partialToolJson.set(index, nextJson);
    block.arguments = parseStreamingJson(nextJson) ?? {};
    return { type: "toolcall_delta", contentIndex: index, delta: event.delta ?? "", partial };
  }
  if (event.type === "toolcall_end") {
    const block = partial.content[index];
    if (block?.type !== "toolCall") throw new Error("Received tool end before tool start");
    partialToolJson.delete(index);
    return { type: "toolcall_end", contentIndex: index, toolCall: block, partial };
  }
  if (event.type === "done") {
    partial.stopReason = event.reason === "length" || event.reason === "toolUse" ? event.reason : "stop";
    partial.usage = event.usage ?? emptyUsage();
    return { type: "done", reason: partial.stopReason, message: partial };
  }
  if (event.type === "error") {
    const reason = event.reason === "aborted" ? "aborted" : "error";
    partial.stopReason = reason;
    partial.errorMessage = event.errorMessage ?? "Provider request failed";
    partial.usage = event.usage ?? emptyUsage();
    return { type: "error", reason, error: partial };
  }
  return undefined;
}

async function safeHttpError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { detail?: { message?: string }; error?: { message?: string } };
    return payload.detail?.message ?? payload.error?.message ?? `Provider proxy failed with HTTP ${response.status}`;
  } catch {
    return `Provider proxy failed with HTTP ${response.status}`;
  }
}
