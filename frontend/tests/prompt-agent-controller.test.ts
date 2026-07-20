import { createDefaultProfileState } from "../src/profile-adapter";
import { PromptAgentController } from "../src/agent/controller";
import { useChatStore } from "../src/stores/chat";
import { useProfileStore } from "../src/stores/profiles";
import { useRuntimeStore } from "../src/stores/runtime";
import type { PromptAgentMessage } from "../src/sessions/schema";

const repository = {
  putSession: vi.fn(async (): Promise<void> => undefined),
  getSession: vi.fn(async () => undefined),
  listSessions: vi.fn(async () => []),
  putMessage: vi.fn(async (_message: PromptAgentMessage): Promise<void> => undefined),
  getMessages: vi.fn(async () => []),
  putPreference: vi.fn(async (): Promise<void> => undefined),
  getPreference: vi.fn(async () => undefined),
  markInterrupted: vi.fn(async () => 0),
};

const installFetch = (stream?: () => Response | Promise<Response>): void => {
  const profiles = createDefaultProfileState();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/prompt-agent/api/profiles") return new Response(JSON.stringify(profiles), { status: 200 });
    if (stream) return stream();
    return new Response([
      'data: {"type":"start"}',
      'data: {"type":"text_start","contentIndex":0}',
      'data: {"type":"text_delta","contentIndex":0,"delta":"Done"}',
      'data: {"type":"text_end","contentIndex":0}',
      'data: {"type":"done","reason":"stop"}',
      "",
    ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }));
};

describe("PromptAgentController recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useChatStore.getState().reset();
    useProfileStore.getState().reset();
    useRuntimeStore.getState().reset();
  });

  it("re-enables the composer when persistence rejects after generation", async () => {
    installFetch();
    repository.putMessage.mockRejectedValue(new Error("session write failed"));
    const controller = new PromptAgentController(repository);
    await controller.mount();

    await expect(controller.actions.sendMessage({ text: "Hello", attachments: [], reasoning: "none" })).rejects.toThrow("session write failed");

    expect(useChatStore.getState().activeRequestId).toBeNull();
    expect(useRuntimeStore.getState().workingPhase).toBe("idle");
    controller.destroy();
  });

  it("serializes runtime writes against the session that produced them", async () => {
    installFetch();
    let releaseFirst: (() => void) | undefined;
    repository.putMessage.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    repository.putMessage.mockImplementation(async () => undefined);
    const controller = new PromptAgentController(repository);
    await controller.mount();
    const sessionId = useRuntimeStore.getState().sessionId;
    const submission = controller.actions.sendMessage({ text: "Hello", attachments: [], reasoning: "none" });

    await vi.waitFor(() => expect(repository.putMessage).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(repository.putMessage).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await submission;

    expect(repository.putMessage.mock.calls.every(([message]) => message.sessionId === sessionId)).toBe(true);
    const statuses = repository.putMessage.mock.calls.map(([message]) => message.status);
    expect(statuses.at(-1)).toBe("complete");
    controller.destroy();
  });

  it("restores the composer after a terminal provider failure", async () => {
    installFetch(() => new Response([
      'data: {"type":"start"}',
      'data: {"type":"error","reason":"error","errorMessage":"provider unavailable"}',
      "",
    ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    repository.putMessage.mockImplementation(async () => undefined);
    const controller = new PromptAgentController(repository);
    await controller.mount();

    await controller.actions.sendMessage({ text: "Hello", attachments: [], reasoning: "none" });

    expect(useChatStore.getState().activeRequestId).toBeNull();
    expect(useRuntimeStore.getState().workingPhase).toBe("idle");
    expect(useRuntimeStore.getState().error).toBe("provider unavailable");
    controller.destroy();
  });

  it("aborts the provider request and restores the composer", async () => {
    let requestAborted = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/prompt-agent/api/profiles") return new Response(JSON.stringify(createDefaultProfileState()), { status: 200 });
      const signal = init?.signal;
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(encoder.encode('data: {"type":"start"}\n\n'));
          const finishAbort = () => {
            requestAborted = true;
            try { streamController.close(); } catch { /* already closed */ }
          };
          if (signal?.aborted) queueMicrotask(finishAbort);
          else signal?.addEventListener("abort", finishAbort, { once: true });
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }));
    repository.putMessage.mockImplementation(async () => undefined);
    const controller = new PromptAgentController(repository);
    await controller.mount();
    const submission = controller.actions.sendMessage({ text: "Hello", attachments: [], reasoning: "none" });
    await vi.waitFor(() => expect(useChatStore.getState().activeRequestId).not.toBeNull());

    controller.actions.stopRequest();
    await submission;

    expect(requestAborted).toBe(true);
    expect(useChatStore.getState().activeRequestId).toBeNull();
    expect(useRuntimeStore.getState().workingPhase).toBe("idle");
    controller.destroy();
  });

  it("passes the selected provider adapter and ordered Forge tools into the runtime", async () => {
    installFetch();
    const controller = new PromptAgentController(repository);
    await controller.mount();

    const runtime = (controller as unknown as { runtime: {
      getTools(): Array<{ name: string }>;
      getSystemPrompt(): string;
    } }).runtime;
    expect(runtime.getTools().map((tool) => tool.name)).toEqual([
      "read_prompt",
      "edit_prompt",
      "read_generation_parameters",
      "apply_generation_parameters",
      "search_resources",
      "inspect_resource",
      "search_danbooru_tags",
      "inspect_danbooru_tags",
      "related_danbooru_tags",
    ]);
    expect(runtime.getSystemPrompt()).toContain("read prompts or generation parameters before changing them");
    expect(runtime.getSystemPrompt()).toContain("search_danbooru_tags");
    controller.destroy();
  });
});
