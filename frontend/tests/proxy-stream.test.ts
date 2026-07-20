import { createPromptAgentStream } from "../src/providers/proxy-stream";
import { toPromptAgentModel } from "../src/providers/proxy-model";

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
    const result = await (await streamFn(model, { messages: [{ role: "user", content: "Hi", timestamp: 1 }] }, {})).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("terminal event");
  });
});
