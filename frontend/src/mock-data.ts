import type { ChatMessage, HistoryRow, PromptAgentActionHandlers } from "./contracts";

export const mockMessages: ChatMessage[] = [
  {
    id: "mock-user-1",
    role: "user",
    content: "Read the current prompt and tell me where the composition feels crowded.",
    status: "complete",
    attachments: [],
    createdAt: 1,
  },
  {
    id: "mock-tool-1",
    role: "tool",
    content: "",
    status: "complete",
    tool: { name: "read_prompt", status: "complete", detail: "Prompt context captured" },
    attachments: [],
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
    createdAt: 3,
  },
];

export const mockHistory: HistoryRow[] = [
  { id: "local-1", source: "prompt-agent", title: "Crowded middle third", preview: "Read the current prompt and tell me...", updatedAt: "Today, 14:42", messageCount: 8 },
  { id: "local-2", source: "prompt-agent", title: "Rainy neon study", preview: "Keep the palette restrained and...", updatedAt: "Yesterday", messageCount: 14 },
];

export const noopActions: PromptAgentActionHandlers = {
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
  undoToolMutation: () => undefined,
  selectHistory: () => undefined,
  newSession: () => undefined,
  openSettings: () => undefined,
};
