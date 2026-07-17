import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Surface from "../src/components/Surface.svelte";
import { mockMessages } from "../src/mock-data";
import { useChatStore } from "../src/stores/chat";
import { useProfileStore } from "../src/stores/profiles";
import { useRuntimeStore } from "../src/stores/runtime";
import { useUiStore } from "../src/stores/ui";

beforeEach(() => {
  useChatStore.getState().reset();
  useProfileStore.getState().reset();
  useRuntimeStore.getState().reset();
  useUiStore.getState().reset();
});

describe("Svelte chat surface", () => {
  it("renders markdown, tools, reasoning, usage, and branches", async () => {
    render(Surface, { initialOpen: true, messages: mockMessages, actions: {} });
    expect(await screen.findByRole("dialog", { name: "Kohaku Loom chat" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Kohaku Loom" })).not.toBeInTheDocument();
    expect(screen.getByText("middle third is carrying too many competing details")).toBeInTheDocument();
    expect(screen.getAllByText("read_prompt").length).toBeGreaterThan(0);
    expect(screen.getByText(/642 in/)).toBeInTheDocument();
    expect(screen.getByText("Reasoning trace").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
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

  it("sends through the typed action interface and switches modes", async () => {
    const user = userEvent.setup();
    const sendMessage = vi.fn();
    render(Surface, { initialOpen: true, actions: { sendMessage } });
    await user.type(screen.getByRole("textbox", { name: "Message Kohaku Loom" }), "Refine this prompt");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Refine this prompt", riskMode: "normal", reasoning: "low" }));
    await user.click(screen.getByRole("button", { name: "Permission mode: confirmations required" }));
    await user.click(screen.getByRole("button", { name: "Allow direct edits" }));
    expect(screen.getByRole("button", { name: "Permission mode: direct edits" })).toHaveAttribute("aria-pressed", "true");
  });

  it("starts a new chat from the dedicated header action", async () => {
    const user = userEvent.setup();
    const newSession = vi.fn();
    render(Surface, { initialOpen: true, messages: mockMessages, actions: { newSession } });
    expect(screen.queryByRole("button", { name: "Chat actions" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start a new chat" }));
    expect(newSession).toHaveBeenCalledOnce();
  });

  it("queues locally while a mocked request is active", async () => {
    const user = userEvent.setup();
    useChatStore.getState().beginRequest("active");
    render(Surface, { initialOpen: true, actions: { sendMessage: vi.fn() } });
    await fireEvent.input(screen.getByRole("textbox", { name: "Message Kohaku Loom" }), { target: { value: "Follow up" } });
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    expect(screen.getByText("Queue 1")).toBeInTheDocument();
  });

  it("shows the current assistant working phase", async () => {
    useChatStore.getState().beginRequest("active");
    render(Surface, { initialOpen: true, actions: {} });

    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    useRuntimeStore.getState().setWorking("generating");
    expect(await screen.findByText("Generating response…")).toBeInTheDocument();
    useRuntimeStore.getState().setWorking("tool", "edit_prompt");
    expect(await screen.findByText("Running tool…")).toBeInTheDocument();
    expect(screen.getByText("edit_prompt")).toBeInTheDocument();

    useChatStore.getState().cancelRequest();
    await waitFor(() => expect(screen.queryByText("Running tool…")).not.toBeInTheDocument());
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
