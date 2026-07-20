import { Agent, type AgentMessage, type AgentOptions, type AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { RuntimeListener } from "./runtime-events";
import {
  initialAgentRuntimeState,
  type AgentRuntimeError,
  type AgentRuntimeState,
  type AgentRuntimeStatus,
} from "./runtime-state";

export interface AgentInput {
  text: string;
  images?: ImageContent[];
  reasoningLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface PromptAgentRuntimeOptions
  extends Pick<AgentOptions, "streamFn" | "convertToLlm" | "transformContext" | "beforeToolCall" | "afterToolCall"> {
  model: Model<any>;
  systemPrompt?: string;
  messages?: AgentMessage[];
  tools?: AgentTool<any>[];
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface PromptAgentRuntime {
  submit(input: AgentInput): Promise<void>;
  abort(): void;
  reset(): void;
  destroy(): void;
  getState(): AgentRuntimeState;
  getMessages(): AgentMessage[];
  getTools(): AgentTool<any>[];
  getSystemPrompt(): string;
  subscribe(listener: RuntimeListener): () => void;
}

const runtimeError = (error: unknown): AgentRuntimeError => ({
  code: "runtime_failed",
  message: error instanceof Error ? error.message : "The agent runtime failed.",
  debugMessage: error instanceof Error ? error.stack : String(error),
  retryable: true,
  cause: error,
});

export class PiPromptAgentRuntime implements PromptAgentRuntime {
  private readonly agent: Agent;
  private readonly listeners = new Set<RuntimeListener>();
  private readonly unsubscribeAgent: () => void;
  private state: AgentRuntimeState = initialAgentRuntimeState();
  private destroyed = false;
  private abortRequested = false;

  constructor(options: PromptAgentRuntimeOptions) {
    this.agent = new Agent({
      initialState: {
        model: options.model,
        systemPrompt: options.systemPrompt ?? "Forge context is available through tools. Read current state before every mutation and use the returned hash for writes.",
        messages: options.messages ?? [],
        tools: options.tools ?? [],
        thinkingLevel: options.thinkingLevel ?? "off",
      },
      streamFn: options.streamFn,
      convertToLlm: options.convertToLlm,
      transformContext: options.transformContext,
      beforeToolCall: options.beforeToolCall,
      afterToolCall: options.afterToolCall,
      toolExecution: "sequential",
    });
    this.state = this.snapshot("idle");
    this.unsubscribeAgent = this.agent.subscribe((event) => {
      let status: AgentRuntimeStatus = this.state.status;
      if (event.type === "agent_start") status = "submitting";
      if (event.type === "message_update") status = "streaming";
      if (event.type === "tool_execution_start" || event.type === "tool_execution_update") status = "tool-calling";
      if (event.type === "agent_end") status = this.agent.state.errorMessage ? "failed" : "completed";
      this.state = this.snapshot(status);
      this.emit();
    });
  }

  async submit(input: AgentInput): Promise<void> {
    this.assertAlive();
    this.abortRequested = false;
    this.state = { ...this.snapshot("submitting"), error: undefined };
    this.emit();
    try {
      if (input.reasoningLevel) this.agent.state.thinkingLevel = input.reasoningLevel;
      await this.agent.prompt(input.text, input.images);
      this.state = this.snapshot(this.agent.state.errorMessage ? "failed" : "completed");
    } catch (error) {
      this.state = { ...this.snapshot("failed"), error: runtimeError(error) };
    }
    this.emit();
  }

  abort(): void {
    if (this.destroyed || !this.agent.state.isStreaming) return;
    this.abortRequested = true;
    this.state = this.snapshot("aborting");
    this.emit();
    this.agent.abort();
  }

  reset(): void {
    this.assertAlive();
    this.abortRequested = false;
    this.agent.reset();
    this.state = initialAgentRuntimeState();
    this.emit();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.agent.abort();
    this.unsubscribeAgent();
    this.listeners.clear();
  }

  getState(): AgentRuntimeState {
    return {
      ...this.state,
      messages: [...this.state.messages],
      pendingToolCalls: [...this.state.pendingToolCalls],
    };
  }

  getMessages(): AgentMessage[] {
    return [...this.agent.state.messages];
  }

  getTools(): AgentTool<any>[] {
    return [...this.agent.state.tools];
  }

  getSystemPrompt(): string {
    return this.agent.state.systemPrompt;
  }

  subscribe(listener: RuntimeListener): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private snapshot(status: AgentRuntimeStatus): AgentRuntimeState {
    const errorMessage = this.agent.state.errorMessage;
    return {
      status,
      messages: [...this.agent.state.messages],
      currentAssistantMessage: this.agent.state.streamingMessage,
      pendingToolCalls: [...this.agent.state.pendingToolCalls],
      error: errorMessage
        ? { code: this.abortRequested ? "runtime_aborted" : "provider_error", message: errorMessage, retryable: true }
        : undefined,
    };
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("PromptAgentRuntime has been destroyed");
  }
}
