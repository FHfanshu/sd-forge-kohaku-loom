import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type AgentRuntimeStatus =
  | "idle"
  | "submitting"
  | "streaming"
  | "tool-calling"
  | "aborting"
  | "completed"
  | "failed";

export interface AgentRuntimeError {
  code: string;
  message: string;
  debugMessage?: string;
  retryable: boolean;
  requestId?: string;
  cause?: unknown;
}

export interface AgentRuntimeState {
  status: AgentRuntimeStatus;
  messages: AgentMessage[];
  currentAssistantMessage?: AgentMessage;
  pendingToolCalls: string[];
  error?: AgentRuntimeError;
}

export const initialAgentRuntimeState = (): AgentRuntimeState => ({
  status: "idle",
  messages: [],
  pendingToolCalls: [],
});
