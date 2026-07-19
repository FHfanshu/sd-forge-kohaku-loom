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

  it("deduplicates queue messages and ignores stale updates", () => {
    useChatStore.getState().reset();
    useChatStore.getState().upsertQueue({ id: "queued-1", text: "new", attachments: [], state: "pending", sequence: 2, updatedAt: 20, createdAt: 1 });
    useChatStore.getState().upsertQueue({ id: "queued-1", text: "old", attachments: [], state: "pending", sequence: 1, updatedAt: 10, createdAt: 1 });
    useChatStore.getState().setQueue([
      { id: "queued-1", text: "new", attachments: [], state: "pending", sequence: 2, updatedAt: 20, createdAt: 1 },
      { id: "queued-1", text: "older duplicate", attachments: [], state: "pending", sequence: 1, updatedAt: 10, createdAt: 1 },
    ]);

    expect(useChatStore.getState().queue).toHaveLength(1);
    expect(useChatStore.getState().queue[0]).toMatchObject({ text: "new", sequence: 2 });
  });

  it("does not keep Base64 queue attachments in memory or localStorage", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem, removeItem: vi.fn() });
    const dataUrl = "data:image/png;base64,AQIDBA==";

    useChatStore.getState().upsertQueue({
      id: "queued-image",
      text: "",
      attachments: [{ id: "image", name: "reference.png", dataUrl }],
      state: "pending",
      createdAt: 1,
    });

    expect(useChatStore.getState().queue[0]).toMatchObject({ attachments: [], attachmentCount: 1 });
    expect(setItem).toHaveBeenCalled();
    expect(String(setItem.mock.calls.at(-1)?.[1])).not.toContain(dataUrl);
  });
});
