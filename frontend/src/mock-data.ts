import type { ChatMessage, HistoryRow, LoomActionHandlers } from "./contracts";

export const mockMessages: ChatMessage[] = [
  {
    id: "mock-user-1",
    role: "user",
    content: "Read the current prompt and tell me where the composition feels crowded.",
    status: "complete",
    attachments: [],
    branchIndex: 0,
    branchCount: 1,
    createdAt: 1,
  },
  {
    id: "mock-tool-1",
    role: "tool",
    content: "",
    status: "complete",
    tool: { name: "read_prompt", status: "complete", detail: "Prompt context captured" },
    attachments: [],
    branchIndex: 0,
    branchCount: 1,
    createdAt: 2,
  },
  {
    id: "mock-assistant-1",
    role: "assistant",
    content: "The focal subject is clear, but the **middle third is carrying too many competing details**. Consider moving the secondary prop closer to the light falloff and reserving the brightest contrast for the face.",
    reasoning: "I compared the subject hierarchy, contrast anchors, and negative space around the main silhouette.",
    status: "complete",
    usage: { inputTokens: 642, outputTokens: 118, latencyMs: 4200 },
    attachments: [],
    branchIndex: 0,
    branchCount: 2,
    createdAt: 3,
  },
];

export const mockHistory: HistoryRow[] = [
  { id: "kt-1", source: "KT", title: "Crowded middle third", preview: "Read the current prompt and tell me...", updatedAt: "Today, 14:42", messageCount: 8 },
  { id: "kt-2", source: "KT", title: "Rainy neon study", preview: "Keep the palette restrained and...", updatedAt: "Yesterday", messageCount: 14 },
  { id: "legacy-1", source: "legacy", title: "Portrait prompt notes", preview: "A legacy Forge assistant session", updatedAt: "Jun 28", messageCount: 5 },
];

export const noopActions: LoomActionHandlers = {
  sendMessage: () => undefined,
  stopRequest: () => undefined,
  attachFiles: () => undefined,
  replaceAttachment: () => undefined,
  removeAttachment: () => undefined,
  readPrompt: () => undefined,
  clearChat: () => undefined,
  copyMessage: async (message) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) await navigator.clipboard.writeText(message.content);
  },
  regenerate: () => undefined,
  undoToolMutation: () => undefined,
  changeBranch: () => undefined,
  removeQueuedMessage: () => undefined,
  selectHistory: () => undefined,
  newSession: () => undefined,
  openSettings: () => undefined,
};
