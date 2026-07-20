import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const PROMPT_AGENT_DATABASE = "sd-forge-neo-prompt-agent";
export const PROMPT_AGENT_DATABASE_VERSION = 2;
export const PROMPT_AGENT_CHANGE_CHANNEL = `${PROMPT_AGENT_DATABASE}:changes`;

export type SessionMessageStatus = "complete" | "streaming" | "interrupted" | "failed";

export interface PromptAgentSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  profileId: string;
  providerId: string;
  modelId: string;
  reasoningLevel: string;
  systemPrompt: string;
  schemaVersion: number;
}

export interface PromptAgentMessage {
  id: string;
  sessionId: string;
  message: AgentMessage;
  status: SessionMessageStatus;
  createdAt: number;
  updatedAt: number;
}

export interface PromptAgentAttachment {
  id: string;
  sessionId: string;
  messageId?: string;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
  createdAt: number;
  updatedAt: number;
}

export type PromptAgentPreferenceValue = string | number | boolean | null;

export interface PromptAgentPreference {
  id: string;
  value: PromptAgentPreferenceValue;
}

export interface PromptAgentProfileCache {
  id: string;
  displayName?: string;
  modelId?: string;
  providerId?: string;
  protocol?: string;
  runtime?: string;
  capabilities?: {
    tools: boolean;
    vision: boolean;
    streaming: boolean;
    reasoning: boolean;
  };
  cachedAt: number;
}

export type SessionChangeEntity = "session" | "message" | "attachment" | "preference" | "profile-cache";
export type SessionChangeOperation = "put" | "delete";

export interface SessionChangeNotification {
  type: "session-change";
  entity: SessionChangeEntity;
  operation: SessionChangeOperation;
  id: string;
  sessionId?: string;
}
