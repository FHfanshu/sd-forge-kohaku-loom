import type { BranchMetadata, ChatMessage } from "./contracts";
import type { KTClient } from "./kt/client";
import { normalizeBranchMetadata } from "./runtime-formatters";
import { useChatStore } from "./stores/chat";
import { useRuntimeStore } from "./stores/runtime";

type Conversation = Record<string, unknown>;

export async function regenerateAssistantResponse(
  client: KTClient,
  sessionId: string,
  message: ChatMessage,
  requestId: string,
  applyConversation: (conversation: Conversation) => void,
): Promise<void> {
  if (message.role !== "assistant" || message.status !== "complete") {
    throw new Error("Only the final completed assistant response can be regenerated");
  }
  if (useChatStore.getState().activeRequestId) {
    throw new Error("Wait for the active response before regenerating");
  }

  const signal = useChatStore.getState().beginRequest(requestId);
  useRuntimeStore.getState().setWorking("thinking");
  useRuntimeStore.getState().setError(null);
  try {
    const response = await client.request<BranchMetadata>(`/sessions/${encodeURIComponent(sessionId)}/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation_id: requestId }),
      signal,
    });
    useRuntimeStore.getState().setBranches(normalizeBranchMetadata(response));
    const conversation = await client.request<Conversation>(`/sessions/${encodeURIComponent(sessionId)}`, { signal });
    applyConversation(conversation);
  } finally {
    useChatStore.getState().finishRequest(requestId);
    useRuntimeStore.getState().setWorking("idle");
  }
}
