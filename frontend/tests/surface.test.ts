import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Surface from "../src/components/Surface.svelte";
import { mockMessages } from "../src/mock-data";
import { useChatStore } from "../src/stores/chat";
import { useProfileStore } from "../src/stores/profiles";
import { useRuntimeStore } from "../src/stores/runtime";
import { useUiStore } from "../src/stores/ui";

function installObjectUrlMocks(): { create: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> } {
  let index = 0;
  const create = vi.fn(() => `blob:surface-${++index}`);
  const revoke = vi.fn();
  const MockUrl = class extends URL {};
  Object.defineProperties(MockUrl, {
    createObjectURL: { value: create },
    revokeObjectURL: { value: revoke },
  });
  vi.stubGlobal("URL", MockUrl);
  vi.stubGlobal("createImageBitmap", vi.fn(() => Promise.reject(new Error("decode unavailable"))));
  return { create, revoke };
}

beforeEach(() => {
  useChatStore.getState().reset();
  useProfileStore.getState().reset();
  useRuntimeStore.getState().reset();
  useUiStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Svelte chat surface", () => {
  it("renders markdown, tools, reasoning, usage, and branches", async () => {
    const { container } = render(Surface, { initialOpen: true, messages: mockMessages, actions: {} });
    expect(await screen.findByRole("dialog", { name: "Kohaku Loom chat" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Kohaku Loom" })).not.toBeInTheDocument();
    expect(screen.getByText("middle third is carrying too many competing details")).toBeInTheDocument();
    expect(screen.getAllByText("read_prompt").length).toBeGreaterThan(0);
    expect(screen.getByText(/642 in/)).toBeInTheDocument();
    expect(screen.getByText("Reasoning trace").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    const tool = container.querySelector("[data-tool-result='true']")!;
    const response = screen.getByText("middle third is carrying too many competing details");
    expect(tool.compareDocumentPosition(response) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps tool results and reasoning folded with a one-line reasoning preview", async () => {
    const user = userEvent.setup();
    const { container } = render(Surface, { initialOpen: true, messages: mockMessages, actions: {} });

    const toolResult = container.querySelector<HTMLDetailsElement>("[data-tool-result='true']");
    expect(toolResult).not.toBeNull();
    expect(toolResult?.open).toBe(false);
    await user.click(toolResult!.querySelector("summary")!);
    expect(toolResult?.open).toBe(true);

    const reasoning = container.querySelector<HTMLDetailsElement>(".kl-reasoning");
    expect(reasoning).not.toBeNull();
    expect(reasoning?.open).toBe(false);
    expect(reasoning?.querySelector(".kl-reasoning-preview")).toHaveTextContent(mockMessages[2].reasoning!);

    await user.click(screen.getByRole("button", { name: "Collapse response" }));
    expect(screen.queryByText("middle third is carrying too many competing details")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand response" }));
    expect(screen.getByText("middle third is carrying too many competing details")).toBeInTheDocument();
  });

  it("defers Markdown parsing while an assistant message is streaming", () => {
    render(Surface, {
      initialOpen: true,
      messages: [{
        id: "streaming",
        role: "assistant",
        content: "**partial reply**",
        status: "streaming",
        attachments: [],
        branchIndex: 0,
        branchCount: 1,
        createdAt: Date.now(),
      }],
      actions: {},
    });
    expect(screen.getByText("**partial reply**")).toBeInTheDocument();
    expect(screen.queryByText("partial reply")).not.toBeInTheDocument();
  });

  it("renders streaming reasoning as sanitized Markdown", () => {
    render(Surface, {
      initialOpen: true,
      messages: [{
        id: "reasoning-stream",
        role: "assistant",
        content: "Working",
        reasoning: "**compare** `<script>alert(1)</script>`",
        status: "streaming",
        attachments: [],
        branchIndex: 0,
        branchCount: 1,
        createdAt: Date.now(),
      }],
      actions: {},
    });
    expect(screen.getByText("compare").tagName).toBe("STRONG");
    expect(document.querySelector("script")).toBeNull();
  });

  it("guides an empty chat and restores the launcher after closing", async () => {
    const user = userEvent.setup();
    render(Surface, { initialOpen: true, actions: {} });
    expect(screen.getByText("Start with the current prompt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close Kohaku Loom" }));
    expect(screen.getByRole("button", { name: "Open Kohaku Loom" })).toHaveTextContent("Assistant");
  });

  it("moves the launcher without opening the chat", async () => {
    render(Surface, { actions: {} });
    const launcher = screen.getByRole("button", { name: "Open Kohaku Loom" });
    await fireEvent.pointerDown(launcher, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 20, clientY: 20 });
    await fireEvent.pointerMove(launcher, { pointerId: 1, pointerType: "mouse", clientX: 180, clientY: 120 });
    await fireEvent.pointerUp(launcher, { pointerId: 1, pointerType: "mouse", clientX: 180, clientY: 120 });
    expect(useUiStore.getState().launcherPosition).toEqual(expect.objectContaining({ left: expect.any(Number), top: expect.any(Number) }));
    await fireEvent.click(launcher);
    expect(useUiStore.getState().shellOpen).toBe(false);
  });

  it("reopens the launcher without replacing the current draft or session", async () => {
    const user = userEvent.setup();
    const newSession = vi.fn();
    render(Surface, { actions: { newSession } });

    await user.click(screen.getByRole("button", { name: "Open Kohaku Loom" }));
    const composer = screen.getByRole("textbox", { name: "Message Kohaku Loom" });
    await user.type(composer, "Preserve this draft");
    expect(newSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Close Kohaku Loom" }));
    await user.click(screen.getByRole("button", { name: "Open Kohaku Loom" }));
    expect(composer).toHaveValue("Preserve this draft");
    expect(newSession).not.toHaveBeenCalled();
  });

  it("jumps to the latest message on open but respects manual scrolling during streaming", async () => {
    const user = userEvent.setup();
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return this.classList.contains("kl-message-scroll") ? 900 : 0; } });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.classList.contains("kl-message-scroll") ? 200 : 0; } });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    useChatStore.getState().setMessages(mockMessages.map((message) => message.id === "mock-assistant-1" ? { ...message, status: "streaming" } : message));
    try {
      const { container } = render(Surface, { actions: {} });
      await user.click(screen.getByRole("button", { name: "Open Kohaku Loom" }));
      const scroller = container.querySelector<HTMLElement>(".kl-message-scroll")!;
      expect(scroller.scrollTop).toBe(900);

      scroller.scrollTop = 300;
      await fireEvent.scroll(scroller);
      useChatStore.getState().updateMessage("mock-assistant-1", { content: "Streaming while scrolled up" });
      expect(scroller.scrollTop).toBe(300);

      scroller.scrollTop = 700;
      await fireEvent.scroll(scroller);
      useChatStore.getState().updateMessage("mock-assistant-1", { content: "Streaming near the bottom" });
      expect(scroller.scrollTop).toBe(900);
    } finally {
      if (scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
    }
  });

  it("restores the floating window after a virtual keyboard viewport closes", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1400 });
    const visualViewport = Object.assign(new EventTarget(), {
      offsetLeft: 0,
      offsetTop: 0,
      width: 1024,
      height: 768,
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visualViewport });

    useUiStore.getState().setLayout("desktop", { left: 24, top: 9999, width: 460, height: 1200 });
    render(Surface, { initialOpen: true, actions: {} });
    const dialog = screen.getByRole("dialog", { name: "Kohaku Loom chat" });
    const composer = screen.getByRole("textbox", { name: "Message Kohaku Loom" });
    expect(dialog).toHaveStyle({ height: "752px" });

    composer.focus();
    visualViewport.height = 260;
    visualViewport.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(dialog).toHaveStyle({ height: "244px" }));

    composer.blur();
    await waitFor(() => expect(dialog).toHaveStyle({ height: "752px" }));
    expect(useUiStore.getState().layouts.desktop.height).toBe(1200);
  });

  it("waits for explicit session creation before sending", async () => {
    const user = userEvent.setup();
    let releaseSession!: () => void;
    const newSession = vi.fn(() => new Promise<void>((resolve) => { releaseSession = resolve; }));
    const sendMessage = vi.fn();
    render(Surface, { actions: { newSession, sendMessage } });

    await user.click(screen.getByRole("button", { name: "Open Kohaku Loom" }));
    await user.click(screen.getByRole("button", { name: "Start a new chat" }));
    await user.type(screen.getByRole("textbox", { name: "Message Kohaku Loom" }), "No duplicate session");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(sendMessage).not.toHaveBeenCalled();
    releaseSession();
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "No duplicate session" })));
  });

  it("sends through the typed action interface without a permission mode toggle", async () => {
    const user = userEvent.setup();
    const sendMessage = vi.fn();
    render(Surface, { initialOpen: true, actions: { sendMessage } });
    await user.type(screen.getByRole("textbox", { name: "Message Kohaku Loom" }), "Refine this prompt");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Refine this prompt", reasoning: "low" }));
    expect(screen.getByRole("textbox", { name: "Message Kohaku Loom" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: /Permission mode/ })).not.toBeInTheDocument();
  });

  it("keeps the touch composer focused and sendable while the virtual keyboard is open", async () => {
    const user = userEvent.setup();
    const sendMessage = vi.fn();
    render(Surface, { initialOpen: true, actions: { sendMessage } });
    const composer = screen.getByRole("textbox", { name: "Message Kohaku Loom" });
    await user.type(composer, "Send above the keyboard");
    expect(composer).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Resize chat window" })).not.toBeInTheDocument();

    const send = screen.getByRole("button", { name: "Send message" });
    expect(await fireEvent.pointerDown(send, { pointerId: 7, pointerType: "touch" })).toBe(false);
    expect(composer).toHaveFocus();
    await fireEvent.click(send);

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Send above the keyboard" }));
    expect(composer).toHaveFocus();
  });

  it("clears the composer immediately while remote acceptance is pending", async () => {
    const user = userEvent.setup();
    let accept!: () => void;
    const sendMessage = vi.fn(() => new Promise<void>((resolve) => { accept = resolve; }));
    render(Surface, { initialOpen: true, actions: { sendMessage } });
    const composer = screen.getByRole("textbox", { name: "Message Kohaku Loom" });
    await user.type(composer, "hello");

    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(composer).toHaveValue("");
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }));
    accept();
  });

  it("loads Edit into the composer and reruns only through the existing send button", async () => {
    const user = userEvent.setup();
    const sendMessage = vi.fn();
    render(Surface, { initialOpen: true, messages: mockMessages, actions: { sendMessage } });

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const composer = screen.getByRole("textbox", { name: "Message Kohaku Loom" });
    expect(composer).toHaveValue(mockMessages[0].content);
    expect(screen.getByText("Editing message")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    await user.clear(composer);
    await user.type(composer, "Edited request");
    expect(sendMessage).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Edited request", editOf: mockMessages[0].id }));
  });

  it("shows regeneration progress and reports a recoverable failure", async () => {
    const user = userEvent.setup();
    let reject!: (error: Error) => void;
    const regenerate = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    render(Surface, { initialOpen: true, messages: mockMessages, actions: { regenerate } });

    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(regenerate).toHaveBeenCalledWith(mockMessages.at(-1));
    reject(new Error("regeneration unavailable"));

    expect(await screen.findByRole("alert")).toHaveTextContent("regeneration unavailable");
  });

  it("materializes attached images only when sending and releases accepted previews", async () => {
    const user = userEvent.setup();
    const { revoke } = installObjectUrlMocks();
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const sendMessage = vi.fn();
    const { container } = render(Surface, { initialOpen: true, actions: { sendMessage } });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;

    await user.upload(fileInput, new File([new Uint8Array([1, 2, 3])], "reference.png", { type: "image/png" }));
    const preview = await screen.findByRole("button", { name: "Preview reference.png" });
    expect(preview.querySelector("img")).toHaveAttribute("src", "blob:surface-1");
    expect(read).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage.mock.calls[0]?.[0].attachments).toEqual([
      expect.objectContaining({ name: "reference.png", dataUrl: expect.stringMatching(/^data:image\/png;base64,/) }),
    ]);
    expect(read).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Preview reference.png" })).not.toBeInTheDocument();
  });

  it("keeps the blob preview owned by an accepted message until unmount", async () => {
    const user = userEvent.setup();
    const { revoke } = installObjectUrlMocks();
    const sendMessage = vi.fn((input) => {
      useChatStore.getState().appendMessage({ id: "accepted-user", role: "user", content: input.text, attachments: input.displayAttachments ?? [], status: "complete" });
    });
    const { container, unmount } = render(Surface, { initialOpen: true, actions: { sendMessage } });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;

    await user.upload(fileInput, new File([new Uint8Array([1, 2, 3])], "message.png", { type: "image/png" }));
    await user.type(screen.getByRole("textbox", { name: "Message Kohaku Loom" }), "Keep the preview");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(screen.getByText("Keep the preview", { exact: true })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Preview message.png" }).querySelector("img")).toHaveAttribute("src", "blob:surface-1");
    expect(revoke).not.toHaveBeenCalled();

    unmount();
    expect(revoke).not.toHaveBeenCalled();
    useChatStore.getState().reset();
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:surface-1");
  });

  it("keeps attachment blobs available after a rejected send", async () => {
    const user = userEvent.setup();
    const { revoke } = installObjectUrlMocks();
    const sendMessage = vi.fn(() => Promise.reject(new Error("provider unavailable")));
    const { container } = render(Surface, { initialOpen: true, actions: { sendMessage } });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;

    await user.upload(fileInput, new File([new Uint8Array([1, 2, 3])], "retry.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("provider unavailable");
    expect(screen.getByRole("button", { name: "Preview retry.png" }).querySelector("img")).toHaveAttribute("src", "blob:surface-1");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("keeps unsent attachments when creating a new session fails", async () => {
    const user = userEvent.setup();
    const { revoke } = installObjectUrlMocks();
    const newSession = vi.fn(() => Promise.reject(new Error("session unavailable")));
    const { container } = render(Surface, { initialOpen: true, actions: { newSession } });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;

    await user.upload(fileInput, new File([new Uint8Array([1, 2, 3])], "draft.png", { type: "image/png" }));
    await user.type(screen.getByRole("textbox", { name: "Message Kohaku Loom" }), "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Start a new chat" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("session unavailable");
    expect(screen.getByRole("textbox", { name: "Message Kohaku Loom" })).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Preview draft.png" })).toBeInTheDocument();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("localizes the combined attachment limit and keeps the draft recoverable", async () => {
    const user = userEvent.setup();
    const sendMessage = vi.fn();
    render(Surface, {
      initialOpen: true,
      initialAttachments: [
        { id: "large-a", name: "first.png", dataUrl: "data:image/png;base64,AQ==", size: 9 * 1024 * 1024 },
        { id: "large-b", name: "second.png", dataUrl: "data:image/png;base64,Ag==", size: 9 * 1024 * 1024 },
      ],
      actions: { sendMessage },
    });
    const composer = screen.getByRole("textbox", { name: "Message Kohaku Loom" });
    await user.type(composer, "Keep this draft");

    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("18.0 MB");
    expect(screen.getByRole("alert")).toHaveTextContent("16.0 MB");
    expect(screen.getByRole("alert")).toHaveTextContent("draft and attachments were kept");
    expect(composer).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Preview first.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview second.png" })).toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("releases previews after removal, replacement, and unmount", async () => {
    const user = userEvent.setup();
    const { revoke } = installObjectUrlMocks();
    const { container, unmount } = render(Surface, { initialOpen: true, actions: {} });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;
    const replacementInput = container.querySelector<HTMLInputElement>('input[type="file"]:not([multiple])')!;

    await user.upload(fileInput, new File([new Uint8Array([1])], "remove.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "Remove remove.png" }));
    expect(revoke).toHaveBeenNthCalledWith(1, "blob:surface-1");

    await user.upload(fileInput, new File([new Uint8Array([2])], "replace.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "Edit replace.png" }));
    await user.click(screen.getByRole("menuitem", { name: "Replace" }));
    await user.upload(replacementInput, new File([new Uint8Array([3])], "replacement.png", { type: "image/png" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview replacement.png" })).toBeInTheDocument());
    expect(revoke).toHaveBeenNthCalledWith(2, "blob:surface-2");

    unmount();
    expect(revoke).toHaveBeenNthCalledWith(3, "blob:surface-3");
  });

  it("renders persisted data URL attachments without object URL ownership", () => {
    const { revoke } = installObjectUrlMocks();
    const dataUrl = "data:image/png;base64,AQID";
    render(Surface, {
      initialOpen: true,
      initialAttachments: [{ id: "persisted", name: "persisted.png", dataUrl }],
      actions: {},
    });

    expect(screen.getByRole("button", { name: "Preview persisted.png" }).querySelector("img")).toHaveAttribute("src", dataUrl);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("starts a new chat from the dedicated header action", async () => {
    const user = userEvent.setup();
    const newSession = vi.fn();
    render(Surface, { initialOpen: true, messages: mockMessages, actions: { newSession } });
    expect(screen.queryByRole("button", { name: "Chat actions" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start a new chat" }));
    expect(newSession).toHaveBeenCalledOnce();
  });

  it("uses separate stop and queue actions while a request is active", async () => {
    const user = userEvent.setup();
    useChatStore.getState().beginRequest("active");
    useRuntimeStore.getState().setWorking("thinking");
    const sendMessage = vi.fn();
    const stopRequest = vi.fn();
    render(Surface, { initialOpen: true, actions: { sendMessage, stopRequest } });
    expect(screen.getByRole("button", { name: "Stop response" })).toBeInTheDocument();
    await fireEvent.input(screen.getByRole("textbox", { name: "Message Kohaku Loom" }), { target: { value: "Follow up" } });
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Follow up" }));
    await user.click(screen.getByRole("button", { name: "Stop response" }));
    expect(stopRequest).toHaveBeenCalledOnce();
  });

  it("shows the current assistant working phase", async () => {
    useChatStore.getState().beginRequest("active");
    useRuntimeStore.getState().setWorking("submitting");
    render(Surface, { initialOpen: true, actions: {} });

    expect(screen.getByText("Sending request…")).toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    useRuntimeStore.getState().setWorking("thinking");
    expect(await screen.findByText("Thinking…")).toBeInTheDocument();
    useChatStore.getState().appendMessage({ id: "assistant-active", role: "assistant", content: "", reasoning: "draft rationale", status: "streaming" });
    useRuntimeStore.getState().setWorking("generating");
    expect(await screen.findByText("Generating response…")).toBeInTheDocument();
    expect(screen.getByText("Reasoning: draft rationale")).toBeInTheDocument();
    useRuntimeStore.getState().setWorking("tool", "edit_prompt");
    expect((await screen.findByText("Running tool…")).closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Tool: edit_prompt")).toBeInTheDocument();

    useChatStore.getState().cancelRequest();
    await waitFor(() => expect(screen.queryByText("Running tool…")).not.toBeInTheDocument());
  });

  it("offers undo on a successful prompt tool result", async () => {
    const user = userEvent.setup();
    const undoToolMutation = vi.fn();
    const messages = [
      { ...mockMessages[1], tool: { ...mockMessages[1].tool!, name: "edit_prompt", undoable: true, undone: false } },
      mockMessages[2],
    ];
    render(Surface, { initialOpen: true, messages, actions: { undoToolMutation } });

    await user.click(screen.getByText("edit_prompt"));
    await user.click(screen.getByRole("button", { name: "Undo change" }));

    expect(undoToolMutation).toHaveBeenCalledWith(messages[0]);
  });

  it("preserves text typed after an accepted submission", async () => {
    const user = userEvent.setup();
    let accept!: () => void;
    const sendMessage = vi.fn(() => new Promise<void>((resolve) => { accept = resolve; }));
    render(Surface, { initialOpen: true, actions: { sendMessage } });
    const composer = screen.getByRole("textbox", { name: "Message Kohaku Loom" });

    await user.type(composer, "First request");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await user.type(composer, " and next draft");
    accept();

    await waitFor(() => expect(composer).toHaveValue(" and next draft"));
  });

  it("shows a recoverable status while the sidecar is starting", () => {
    useRuntimeStore.getState().setStartup("starting");
    render(Surface, { initialOpen: true, actions: { sendMessage: vi.fn() } });

    expect(screen.getByRole("status")).toHaveTextContent("Loom runtime is starting or unavailable");
  });

  it("shows connection progress instead of mock history while the host bridge is unavailable", async () => {
    render(Surface, { initialOpen: true });

    expect(screen.getByRole("status")).toHaveTextContent("Connecting to Forge runtime");
    await fireEvent.click(screen.getByRole("button", { name: "Open chat history" }));
    expect(screen.getByRole("dialog", { name: "Chat history" })).toHaveTextContent("Loading chat history");
    expect(screen.queryByText("Mock archived chat")).not.toBeInTheDocument();
  });

  it("offers retry after the host connection deadline", async () => {
    vi.useFakeTimers();
    render(Surface, { initialOpen: true });

    await vi.advanceTimersByTimeAsync(15_100);

    expect(screen.getByRole("alert")).toHaveTextContent("host API did not become ready");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("offers retry for failed queued messages and exposes paused state", async () => {
    const user = userEvent.setup();
    const retryQueuedMessage = vi.fn();
    useRuntimeStore.getState().setQueuePaused(true);
    useChatStore.getState().upsertQueue({ id: "failed-1", text: "Try again", attachments: [], state: "failed", createdAt: 1 });
    render(Surface, { initialOpen: true, actions: { retryQueuedMessage } });

    expect(screen.getByRole("status")).toHaveTextContent("Queue is paused");
    await user.click(screen.getByRole("button", { name: "Retry queued message failed-1" }));
    expect(retryQueuedMessage).toHaveBeenCalledWith("failed-1");
  });

  it("keeps the composer input and actions inside one rounded shell", () => {
    const { container } = render(Surface, { initialOpen: true, actions: {} });
    const composer = container.querySelector("form.kl-composer");

    expect(composer).not.toBeNull();
    expect(composer?.querySelector("textarea")).toBeInTheDocument();
    expect(composer?.querySelector(".kl-composer-bottom")).toBeInTheDocument();
    expect(composer?.querySelector(".kl-send-button")).toBeInTheDocument();
    expect(composer?.querySelector(".kl-composer-bottom")?.closest("form")).toBe(composer);
    expect(composer?.querySelector(".kl-send-button")?.closest("form")).toBe(composer);
  });

  it("switches the active model from the composer", async () => {
    const user = userEvent.setup();
    render(Surface, { initialOpen: true, actions: {} });
    const next = useProfileStore.getState().profiles.find((profile) => profile.enabled && profile.id !== useProfileStore.getState().activeProfileId);
    expect(next).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Active model" }));
    await user.click(screen.getByRole("option", { name: new RegExp(next!.displayName) }).querySelector("button")!);
    expect(useProfileStore.getState().activeProfileId).toBe(next!.id);
  });

  it("restores the reasoning effort popover and persists a selected level", async () => {
    const user = userEvent.setup();
    render(Surface, { initialOpen: true, actions: {} });

    await user.click(screen.getByRole("button", { name: "Change reasoning effort" }));
    const popover = screen.getByRole("dialog", { name: "Reasoning effort" });
    expect(popover).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Enable reasoning" })).not.toBeInTheDocument();
    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    await fireEvent.input(slider, { target: { value: "0" } });
    await fireEvent.change(slider, { target: { value: "0" } });
    expect(useProfileStore.getState().profiles.find((profile) => profile.id === useProfileStore.getState().activeProfileId)?.parameters.reasoningEffort).toBe("none");
    await fireEvent.input(slider, { target: { value: "3" } });
    await fireEvent.change(slider, { target: { value: "3" } });

    expect(useProfileStore.getState().profiles.find((profile) => profile.id === useProfileStore.getState().activeProfileId)?.parameters.reasoningEffort).toBe("high");
    expect(screen.getByRole("button", { name: "Change reasoning effort" })).toHaveTextContent("High");
  });

  it("closes nested pickers with Escape without closing the chat", async () => {
    const user = userEvent.setup();
    render(Surface, { initialOpen: true, actions: {} });
    await user.click(screen.getByRole("button", { name: "Change reasoning effort" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Reasoning effort" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Kohaku Loom chat" })).toBeInTheDocument();
  });
});
