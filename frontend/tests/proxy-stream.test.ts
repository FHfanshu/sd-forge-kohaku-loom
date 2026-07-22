import { createPromptAgentStream } from "../src/providers/proxy-stream";
import { toPromptAgentModel } from "../src/providers/proxy-model";
import { acceptanceTest } from "./acceptance";

const encoder = new TextEncoder();
const model = toPromptAgentModel({
  id: "test-model",
  providerId: "openai-compatible",
  displayName: "Test",
  capabilities: { streaming: true, tools: true, vision: false, reasoning: true, attachments: false, systemPrompt: true },
  contextWindow: 8192,
  maxTokens: 1024,
});

function response(...events: unknown[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("prompt agent proxy stream", () => {
  it("reconstructs text and sends only the profile authority", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return response(
        { type: "start" },
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "Hello" },
        { type: "text_end", contentIndex: 0 },
        { type: "done", reason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      );
    };
    const streamFn = createPromptAgentStream(() => "profile-1", "/prompt-agent/api/stream", fetchImpl);
    const stream = await streamFn(model, { messages: [{ role: "user", content: "Hi", timestamp: 1 }] }, {});
    const result = await stream.result();

    expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(body.profile_id).toBe("profile-1");
    expect(JSON.stringify(body)).not.toMatch(/apiKey|api_key|endpoint|modelPath|headers/);
  });

  it("fails when the response ends without a terminal event", async () => {
    const streamFn = createPromptAgentStream(() => "profile-1", "/prompt-agent/api/stream", async () => response({ type: "start" }));
    const result = await (await streamFn(model, { messages: [{ role: "user", content: "Hi", timestamp: 1 }] }, { maxRetryDelayMs: 0 })).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("terminal event");
  });

  acceptanceTest("SESSION-LIFECYCLE-001@2", "retry,failure", "retries a transient HTTP failure before the agent loop sees an error", async () => {
    let attempts = 0;
    const retries: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response(JSON.stringify({ detail: { message: "Provider request failed (HTTP 502)." } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return response(
        { type: "start" },
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "Recovered" },
        { type: "text_end", contentIndex: 0 },
        { type: "done", reason: "stop" },
      );
    };
    const streamFn = createPromptAgentStream(
      () => "profile-1",
      "/prompt-agent/api/stream",
      fetchImpl,
      () => "turn-1",
      ({ attempt }) => retries.push(attempt),
    );

    const result = await (await streamFn(model, { messages: [] }, { maxRetryDelayMs: 0 })).result();

    expect(attempts).toBe(3);
    expect(retries).toEqual([2, 3]);
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "Recovered" }]);
  });

  it("retries a transient provider error delivered inside the SSE stream", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      return attempts === 1
        ? response(
          { type: "start" },
          { type: "error", reason: "error", errorCode: "provider_http_error", statusCode: 503, errorMessage: "Provider request failed (HTTP 503)." },
        )
        : response({ type: "start" }, { type: "done", reason: "stop" });
    };
    const streamFn = createPromptAgentStream(() => "profile-1", undefined, fetchImpl);

    const result = await (await streamFn(model, { messages: [] }, { maxRetryDelayMs: 0 })).result();

    expect(attempts).toBe(2);
    expect(result.stopReason).toBe("stop");
  });

  it("does not replay a request after streamed output has begun", async () => {
    let attempts = 0;
    const streamFn = createPromptAgentStream(() => "profile-1", undefined, async () => {
      attempts += 1;
      return response(
        { type: "start" },
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "Partial" },
        { type: "error", reason: "error", errorCode: "provider_http_error", statusCode: 502, errorMessage: "Provider request failed (HTTP 502)." },
      );
    });

    const result = await (await streamFn(model, { messages: [] }, { maxRetryDelayMs: 0 })).result();

    expect(attempts).toBe(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("HTTP 502");
  });

  it("does not retry non-transient HTTP errors", async () => {
    let attempts = 0;
    const streamFn = createPromptAgentStream(() => "profile-1", undefined, async () => {
      attempts += 1;
      return new Response(JSON.stringify({ detail: { message: "Invalid request." } }), { status: 400 });
    });

    const result = await (await streamFn(model, { messages: [] }, { maxRetryDelayMs: 0 })).result();

    expect(attempts).toBe(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Invalid request.");
  });

  it("aborts immediately while a retry is pending", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const streamFn = createPromptAgentStream(
      () => "profile-1",
      undefined,
      async () => {
        attempts += 1;
        return new Response("temporary", { status: 503 });
      },
      () => "",
      () => controller.abort(),
    );

    const result = await (await streamFn(model, { messages: [] }, { signal: controller.signal })).result();

    expect(attempts).toBe(1);
    expect(result.stopReason).toBe("aborted");
  });
});
