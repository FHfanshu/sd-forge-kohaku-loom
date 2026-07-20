import { createStore } from "./store";
import {
  chatMessageSchema,
  type ChatAttachment,
  type ChatMessage,
  type ChatMessageInput,
} from "../contracts";
import { releaseImageAttachments, retainImageAttachments } from "../attachments";

export interface ChatStore {
  messages: ChatMessage[];
  activeRequestId: string | null;
  setActiveRequest(requestId: string | null): void;
  appendMessage(message: ChatMessageInput): void;
  upsertMessage(message: ChatMessageInput): void;
  updateMessage(id: string, patch: Partial<ChatMessage>): void;
  setMessages(messages: ChatMessage[]): void;
  setAttachments(messageId: string, attachments: ChatAttachment[]): void;
  beginRequest(requestId: string): AbortSignal;
  cancelRequest(): void;
  finishRequest(requestId?: string): void;
  reset(): void;
}

let activeController: AbortController | null = null;
function replaceOwnedAttachments(current: ChatAttachment[], next: ChatAttachment[]): void {
  retainImageAttachments(next);
  releaseImageAttachments(current);
}

export const useChatStore = createStore<ChatStore>((set, get) => ({
  messages: [],
  activeRequestId: null,
  setActiveRequest(activeRequestId) {
    set({ activeRequestId });
  },
  appendMessage(message) {
    const parsed = chatMessageSchema.parse(message);
    retainImageAttachments(parsed.attachments);
    set((state) => ({ messages: [...state.messages, parsed] }));
  },
  upsertMessage(message) {
    const parsed = chatMessageSchema.parse(message);
    set((state) => {
      const index = state.messages.findIndex((item) => item.id === parsed.id);
      if (index < 0) {
        retainImageAttachments(parsed.attachments);
        return { messages: [...state.messages, parsed] };
      }
      const messages = state.messages.slice();
      replaceOwnedAttachments(messages[index].attachments, parsed.attachments);
      messages[index] = parsed;
      return { messages };
    });
  },
  updateMessage(id, patch) {
    set((state) => ({ messages: state.messages.map((message) => {
      if (message.id !== id) return message;
      const next = chatMessageSchema.parse({ ...message, ...patch });
      replaceOwnedAttachments(message.attachments, next.attachments);
      return next;
    }) }));
  },
  setMessages(messages) {
    const next = messages.map((message) => chatMessageSchema.parse(message));
    replaceOwnedAttachments(get().messages.flatMap((message) => message.attachments), next.flatMap((message) => message.attachments));
    set({ messages: next });
  },
  setAttachments(messageId, attachments) {
    set((state) => ({
      messages: state.messages.map((message) => message.id === messageId
        ? (() => {
          const next = chatMessageSchema.parse({ ...message, attachments });
          replaceOwnedAttachments(message.attachments, next.attachments);
          return next;
        })()
        : message),
    }));
  },
  beginRequest(requestId) {
    activeController?.abort();
    activeController = new AbortController();
    set({ activeRequestId: requestId });
    return activeController.signal;
  },
  cancelRequest() {
    activeController?.abort();
    activeController = null;
    set((state) => ({
      activeRequestId: null,
      messages: state.messages.map((message) =>
        message.status === "streaming" ? { ...message, status: "cancelled" } : message,
      ),
    }));
  },
  finishRequest(requestId) {
    if (requestId && get().activeRequestId !== requestId) return;
    activeController = null;
    set({ activeRequestId: null });
  },
  reset() {
    activeController?.abort();
    activeController = null;
    releaseImageAttachments(get().messages.flatMap((message) => message.attachments));
    set({ messages: [], activeRequestId: null });
  },
}));
