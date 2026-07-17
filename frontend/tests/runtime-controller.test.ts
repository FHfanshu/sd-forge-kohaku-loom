import { describe, expect, it, vi } from "vitest";
import { LoomRuntimeController } from "../src/runtime-controller";
import { useChatStore } from "../src/stores/chat";
import { useRuntimeStore } from "../src/stores/runtime";

function controllerWith(
  kt: Promise<unknown>,
  legacy: Promise<unknown>,
): LoomRuntimeController {
  const host = { listLegacySessions: vi.fn(() => legacy) } as never;
  const client = { request: vi.fn(() => kt) } as never;
  return new LoomRuntimeController(host, client);
}

describe("runtime session history", () => {
  it("keeps legacy sessions visible when the KT sidecar is unavailable", async () => {
    const controller = controllerWith(
      Promise.reject(new Error("sidecar unavailable")),
      Promise.resolve({ sessions: [{ session_id: "legacy-1", title: "Legacy chat" }] }),
    );

    const rows = await controller.loadHistory();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "legacy-1", source: "legacy", title: "Legacy chat" });
    expect(useRuntimeStore.getState().history).toEqual(rows);
  });

  it("keeps KT sessions visible when the legacy reader is unavailable", async () => {
    const controller = controllerWith(
      Promise.resolve({ sessions: [{ session_id: "kt-1", title: "KT chat" }] }),
      Promise.reject(new Error("legacy reader unavailable")),
    );

    const rows = await controller.loadHistory();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "kt-1", source: "KT", title: "KT chat" });
  });

  it("uses a readable placeholder while a KT title is still pending", async () => {
    const controller = controllerWith(
      Promise.resolve({ sessions: [{ session_id: "kt-1", status: "pending" }] }),
      Promise.resolve({ sessions: [] }),
    );

    const rows = await controller.loadHistory();

    expect(rows[0]).toMatchObject({ id: "kt-1", title: "Untitled session" });
  });

  it("refreshes the archive when async metadata generation publishes an event", async () => {
    const abort = new AbortController();
    const request = vi.fn(() => Promise.resolve({ sessions: [{ session_id: "kt-1", title: "Updated title" }] }));
    const stream = vi.fn(async function* (_path: string, options: { signal?: AbortSignal }) {
      yield { sequence: 1, event: "message", data: { type: "session_metadata_updated" } };
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    });
    const host = { listLegacySessions: vi.fn(() => Promise.resolve({ sessions: [] })) } as never;
    const client = { request, stream } as never;
    const controller = new LoomRuntimeController(host, client);

    const task = (controller as unknown as { consumeHistoryEvents(signal: AbortSignal): Promise<void> }).consumeHistoryEvents(abort.signal);
    await vi.waitFor(() => expect(useRuntimeStore.getState().history[0]).toMatchObject({ title: "Updated title" }));

    abort.abort();
    await task;
    expect(stream).toHaveBeenCalledWith("/turns/events", expect.objectContaining({ lastEventId: "0" }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("renders archived tool results as compact tool cards instead of raw JSON", async () => {
    useChatStore.getState().reset();
    const host = {
      getLegacySession: vi.fn(() => Promise.resolve({
        events: [
          { event_type: "user_message", payload: { content: "Review this prompt" } },
          { event_type: "assistant_message", payload: { content: "", tool_calls: [{ tool: "read_prompt" }] } },
          { event_type: "tool_result", payload: { tool: "read_prompt", result: { ok: true }, content: '{"prompt":"secret raw payload"}' } },
          { event_type: "tool_result", payload: { tool: "ask_teacher", result: { ok: false, error: "https://private.invalid failed" } } },
        ],
      })),
    } as never;
    const controller = new LoomRuntimeController(host, {} as never);

    await controller.actions.selectHistory({ id: "legacy-1", source: "legacy", title: "Archive", preview: "", updatedAt: "now", messageCount: 4 });

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: "user", content: "Review this prompt" });
    expect(messages[1]).toMatchObject({ role: "tool", content: "", tool: { name: "read_prompt", status: "complete" } });
    expect(messages[2]).toMatchObject({ role: "tool", content: "", status: "error", tool: { name: "ask_teacher", status: "error" } });
    expect(JSON.stringify(messages)).not.toContain("private.invalid");
    expect(JSON.stringify(messages)).not.toContain("secret raw payload");
  });

  it("keeps internal system prompts out of restored KT conversations", async () => {
    useChatStore.getState().reset();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    const host = {
      assistantConfig: vi.fn(() => ({ profile_id: "local" })),
      syncProfiles: vi.fn(() => Promise.resolve({})),
      profileStore: { load: vi.fn(() => ({ profiles: [] })), requestProjection: vi.fn(() => ({})) },
    } as never;
    const client = {
      request: vi.fn((path: string) => {
        if (path === "/profiles/import") return Promise.resolve({});
        if (path === "/sessions/open") return Promise.resolve({ session: { session_id: "kt-1" } });
        if (path === "/sessions/kt-1") return Promise.resolve({
          messages: [
            { id: "system", role: "system", content: "private runtime instructions" },
            { id: "user", role: "user", content: "Hello" },
            { id: "assistant", role: "assistant", content: "Hi" },
          ],
        });
        if (path === "/runtime") return Promise.resolve({});
        throw new Error(`unexpected path: ${path}`);
      }),
    } as never;
    const controller = new LoomRuntimeController(host, client);

    await controller.openSession("kt-1", true);

    expect(useChatStore.getState().messages.map((message) => message.content)).toEqual(["Hello", "Hi"]);
    vi.unstubAllGlobals();
  });

  it("persists the Svelte risk mode to an active KT session", async () => {
    const request = vi.fn(() => Promise.resolve({ session: { session_id: "kt-1", agent_mode: "yolo" } }));
    const controller = new LoomRuntimeController({} as never, { request } as never);
    useRuntimeStore.getState().setSession({ session_id: "kt-1", agent_mode: "normal" });

    await controller.actions.setRiskMode("yolo");

    expect(request).toHaveBeenCalledWith("/sessions/kt-1/mode", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ agent_mode: "yolo" }),
    }));
    expect(useRuntimeStore.getState().session?.agent_mode).toBe("yolo");
  });

  it("closes any remote active session before creating a fresh one", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    const host = {
      assistantConfig: vi.fn(() => ({ profile_id: "local" })),
      syncProfiles: vi.fn(() => Promise.resolve({})),
    } as never;
    const request = vi.fn((path: string) => {
      if (path === "/sessions/close") return Promise.resolve({ ok: true });
      if (path === "/sessions/open") return Promise.resolve({ session: { session_id: "fresh" } });
      if (path === "/sessions/fresh") return Promise.resolve({ messages: [] });
      if (path === "/runtime") return Promise.resolve({ active_session: { session_id: "fresh" } });
      throw new Error(`unexpected path: ${path}`);
    });
    const controller = new LoomRuntimeController(host, { request } as never);

    await controller.newSession();

    expect(request.mock.calls[0]).toEqual(["/sessions/close", { method: "POST" }]);
    expect(useRuntimeStore.getState().sessionId).toBe("fresh");
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("coalesces streaming deltas into one render per animation frame", async () => {
    useChatStore.getState().reset();
    const renders: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      renders.push(callback);
      return 1;
    }));
    const controller = new LoomRuntimeController({} as never, {} as never);
    const internals = controller as unknown as {
      createRun(requestId: string): unknown;
      handleTurnEvent(run: unknown, event: Record<string, unknown>): Promise<void>;
    };
    const run = internals.createRun("stream");

    await internals.handleTurnEvent(run, { type: "text_delta", payload: { text: "a" } });
    await internals.handleTurnEvent(run, { type: "text_delta", payload: { text: "b" } });

    expect(useChatStore.getState().messages.at(-1)?.content).toBe("a");
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    renders[0](16);
    expect(useChatStore.getState().messages.at(-1)?.content).toBe("ab");
    vi.unstubAllGlobals();
  });

  it("reports the active tool while it is running", async () => {
    useChatStore.getState().reset();
    useRuntimeStore.getState().reset();
    let release!: (value: unknown) => void;
    const result = new Promise((resolve) => { release = resolve; });
    const host = { executeTool: vi.fn(() => result) } as never;
    const client = { request: vi.fn(() => Promise.resolve({})) } as never;
    const controller = new LoomRuntimeController(host, client);
    const internals = controller as unknown as {
      createRun(requestId: string): unknown;
      handleToolEvent(run: unknown, event: Record<string, unknown>): Promise<void>;
    };
    const run = internals.createRun("tool-run");
    useChatStore.getState().beginRequest("tool-run");
    useRuntimeStore.getState().setWorking("thinking");

    const pending = internals.handleToolEvent(run, { type: "tool_request", payload: { request_id: "request-1", tool: "edit_prompt", arguments: {} } });
    expect(useRuntimeStore.getState()).toMatchObject({ workingPhase: "tool", workingTool: "edit_prompt" });
    release({ ok: true });
    await pending;

    expect(useRuntimeStore.getState()).toMatchObject({ workingPhase: "thinking", workingTool: null });
    useChatStore.getState().cancelRequest();
    useRuntimeStore.getState().reset();
  });

  it("does not let a stale terminal event finish a newly accepted turn", async () => {
    useChatStore.getState().reset();
    const host = {
      claimToolBridge: vi.fn(() => Promise.resolve({ owned: true, bridge_id: "bridge" })),
      assistantConfig: vi.fn(() => ({ timeout: 120 })),
      captureForgeState: vi.fn(() => ({})),
    } as never;
    const client = {
      request: vi.fn((path: string) => {
        if (path === "/runtime") return Promise.resolve({ turn_event_sequence: 0, tool_event_sequence: 0 });
        if (path === "/turns") return Promise.resolve({ turn_id: "new-turn" });
        throw new Error(`unexpected path: ${path}`);
      }),
      stream: vi.fn(async function* (path: string) {
        if (path === "/turns/events") {
          yield { sequence: 1, data: { type: "turn_ended", payload: { turn_id: "old-turn", status: "completed", text: "old" } } };
          yield { sequence: 2, data: { type: "text_delta", payload: { turn_id: "new-turn", text: "new" } } };
          yield { sequence: 3, data: { type: "turn_ended", payload: { turn_id: "new-turn", status: "completed", text: "new" } } };
        }
      }),
    } as never;
    const controller = new LoomRuntimeController(host, client);
    useRuntimeStore.getState().setSession({ session_id: "kt-1" });

    await controller.sendMessage({ text: "hello", attachments: [], riskMode: "normal", reasoning: "low" });

    expect(useChatStore.getState().messages.some((message) => message.role === "assistant" && message.content === "old")).toBe(false);
    expect(useChatStore.getState().messages.some((message) => message.role === "assistant" && message.content === "new" && message.status === "complete")).toBe(true);
  });

  it("keeps an active turn alive when its SSE connection drops", async () => {
    useChatStore.getState().reset();
    let turnStreamCalls = 0;
    const host = {
      claimToolBridge: vi.fn(() => Promise.resolve({ owned: true, bridge_id: "bridge" })),
      assistantConfig: vi.fn(() => ({ timeout: 120 })),
      captureForgeState: vi.fn(() => ({})),
    } as never;
    const client = {
      request: vi.fn((path: string) => {
        if (path === "/runtime") return Promise.resolve(turnStreamCalls > 1
          ? { active_turn_id: "", last_turn: { turn_id: "turn-1", status: "completed", text: "recovered" } }
          : { active_turn_id: "turn-1", active_turn: { turn_id: "turn-1", text: "partial" }, turn_event_sequence: 0, tool_event_sequence: 0 });
        if (path === "/turns") return Promise.resolve({ turn_id: "turn-1" });
        throw new Error(`unexpected path: ${path}`);
      }),
      stream: vi.fn(async function* (path: string) {
        if (path === "/tools/events") return;
        turnStreamCalls += 1;
        if (turnStreamCalls === 1) throw new TypeError("connection reset");
        yield { sequence: 2, data: { type: "turn_ended", payload: { turn_id: "turn-1", status: "completed", text: "recovered" } } };
      }),
    } as never;
    const controller = new LoomRuntimeController(host, client);
    useRuntimeStore.getState().setSession({ session_id: "kt-1" });

    await controller.sendMessage({ text: "hello", attachments: [], riskMode: "normal", reasoning: "low" });

    expect(turnStreamCalls).toBe(2);
    expect(useChatStore.getState().messages.some((message) => message.role === "assistant" && message.content === "recovered" && message.status === "complete")).toBe(true);
  });
});
