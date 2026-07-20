import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../src/stores/chat";
import { useUiStore } from "../src/stores/ui";

afterEach(() => {
  vi.unstubAllGlobals();
  useChatStore.getState().reset();
  useUiStore.getState().reset();
});

describe("chat store cancellation", () => {
  it("aborts the active request immediately and marks streaming output cancelled", () => {
    useChatStore.getState().reset();
    useChatStore.getState().appendMessage({ id: "assistant-1", role: "assistant", content: "partial", status: "streaming" });
    const signal = useChatStore.getState().beginRequest("request-1");

    expect(signal.aborted).toBe(false);
    useChatStore.getState().cancelRequest();

    expect(signal.aborted).toBe(true);
    expect(useChatStore.getState().activeRequestId).toBeNull();
    expect(useChatStore.getState().messages[0].status).toBe("cancelled");
  });

  it("cancels an older request when a newer request begins", () => {
    useChatStore.getState().reset();
    const first = useChatStore.getState().beginRequest("first");
    const second = useChatStore.getState().beginRequest("second");

    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    expect(useChatStore.getState().activeRequestId).toBe("second");
    useChatStore.getState().cancelRequest();
  });
});
