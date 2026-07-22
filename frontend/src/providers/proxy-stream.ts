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
  statusCode?: number;
  usage?: Usage;
}

type PromptAgentStreamOptions = SimpleStreamOptions & { toolChoice?: string };

export interface StreamRetryNotice {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  statusCode?: number;
}

type RetryListener = (notice: StreamRetryNotice) => void;

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 5_000;
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_PROXY_CODES = new Set([
  "provider_network_error",
  "provider_rate_limited",
  "provider_unexpected_eof",
]);

class ProxyRequestError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly statusCode?: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ProxyRequestError";
  }
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
  turnId: () => string = () => "",
  onRetry?: RetryListener,
): StreamFn => (model, context, options = {}) => {
  const stream = createAssistantMessageEventStream();
  void consumeProxy(stream, model, context, options, profileId(), endpoint, fetchImpl, turnId(), onRetry);
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
  turnId: string,
  onRetry?: RetryListener,
): Promise<void> {
  const createPartial = (): AssistantMessage => ({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const configuredRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxRetries = Number.isFinite(configuredRetries) ? Math.max(0, Math.trunc(configuredRetries)) : DEFAULT_MAX_RETRIES;
  const maxAttempts = maxRetries + 1;
  const configuredMaxDelay = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const maxRetryDelayMs = Number.isFinite(configuredMaxDelay) ? Math.max(0, configuredMaxDelay) : DEFAULT_MAX_RETRY_DELAY_MS;
  let streamStarted = false;
  let emittedOutput = false;
  let lastPartial = createPartial();

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const partial = createPartial();
      lastPartial = partial;
      const partialToolJson = new Map<number, string>();
      let terminal = false;
      let pendingStart: AssistantMessageEvent | undefined;

      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile_id: profileId,
            request_id: crypto.randomUUID(),
            turn_id: turnId || undefined,
            context,
            options: {
              temperature: options.temperature,
              maxTokens: options.maxTokens,
              reasoning: options.reasoning,
              sessionId: options.sessionId,
              toolChoice: (options as PromptAgentStreamOptions).toolChoice,
            },
          }),
          signal: options.signal,
        });
        if (!response.ok) {
          throw new ProxyRequestError(
            await safeHttpError(response),
            RETRYABLE_HTTP_STATUS.has(response.status),
            response.status,
            retryAfterMilliseconds(response),
          );
        }
        if (!response.body) throw new ProxyRequestError("Provider proxy returned no response body", true);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let retryEvent: ProxyEvent | undefined;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const proxyEvent = parseFrame(frame);
            if (!proxyEvent) continue;
            const event = applyProxyEvent(proxyEvent, partial, partialToolJson);
            if (!event) continue;
            if (event.type === "start" && !streamStarted) {
              pendingStart = event;
              continue;
            }
            if (event.type === "error" && !emittedOutput && attempt < maxAttempts && isRetryableProxyEvent(proxyEvent)) {
              retryEvent = proxyEvent;
              break;
            }
            if (!streamStarted) {
              stream.push(pendingStart ?? { type: "start", partial });
              streamStarted = true;
            }
            stream.push(event);
            emittedOutput ||= event.type !== "done" && event.type !== "error";
            terminal ||= event.type === "done" || event.type === "error";
          }
          if (retryEvent) break;
        }
        if (retryEvent) {
          await reader.cancel().catch(() => undefined);
          const delayMs = retryDelay(attempt, maxRetryDelayMs);
          onRetry?.({ attempt: attempt + 1, maxAttempts, delayMs, statusCode: retryEvent.statusCode });
          await abortableDelay(delayMs, options.signal);
          continue;
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
          const proxyEvent = parseFrame(buffer);
          const event = proxyEvent ? applyProxyEvent(proxyEvent, partial, partialToolJson) : undefined;
          if (event) {
            if (event.type === "error" && !emittedOutput && attempt < maxAttempts && isRetryableProxyEvent(proxyEvent!)) {
              const delayMs = retryDelay(attempt, maxRetryDelayMs);
              onRetry?.({ attempt: attempt + 1, maxAttempts, delayMs, statusCode: proxyEvent!.statusCode });
              await abortableDelay(delayMs, options.signal);
              continue;
            }
            if (!streamStarted) {
              stream.push(pendingStart ?? { type: "start", partial });
              streamStarted = true;
            }
            stream.push(event);
            emittedOutput ||= event.type !== "done" && event.type !== "error";
            terminal ||= event.type === "done" || event.type === "error";
          }
        }
        if (!terminal) throw new ProxyRequestError("Provider proxy ended without a terminal event", true);
        return;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const retryable = error instanceof ProxyRequestError ? error.retryable : error instanceof TypeError;
        if (!emittedOutput && attempt < maxAttempts && retryable) {
          const requestedDelay = error instanceof ProxyRequestError ? error.retryAfterMs : undefined;
          const delayMs = Math.min(requestedDelay ?? retryDelay(attempt, maxRetryDelayMs), maxRetryDelayMs);
          onRetry?.({
            attempt: attempt + 1,
            maxAttempts,
            delayMs,
            statusCode: error instanceof ProxyRequestError ? error.statusCode : undefined,
          });
          await abortableDelay(delayMs, options.signal);
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    const reason = options.signal?.aborted ? "aborted" : "error";
    lastPartial.stopReason = reason;
    lastPartial.errorMessage = options.signal?.aborted ? "Request aborted" : error instanceof Error ? error.message : String(error);
    if (!streamStarted) stream.push({ type: "start", partial: lastPartial });
    stream.push({ type: "error", reason, error: lastPartial });
  } finally {
    stream.end();
  }
}

function parseFrame(frame: string): ProxyEvent | undefined {
  const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  return data ? JSON.parse(data) as ProxyEvent : undefined;
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

function isRetryableProxyEvent(event: ProxyEvent): boolean {
  if (event.statusCode !== undefined) return RETRYABLE_HTTP_STATUS.has(event.statusCode);
  return RETRYABLE_PROXY_CODES.has(event.errorCode ?? "");
}

function retryDelay(attempt: number, maxDelayMs: number): number {
  return Math.min(500 * 2 ** (attempt - 1), maxDelayMs);
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const retryAfterMs = Number(response.headers.get("retry-after-ms"));
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return retryAfterMs;
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Request aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
