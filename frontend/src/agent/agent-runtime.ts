import { Agent, type AgentMessage, type AgentOptions, type AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, Model } from "@earendil-works/pi-ai";
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
  requirePromptMutation?: boolean;
  requirePromptToolkit?: boolean;
  requireBackgroundLookup?: boolean;
}

interface PromptAgentControlMessage {
  role: "promptAgentControl";
  content: string;
  timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    promptAgentControl: PromptAgentControlMessage;
  }
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
  replaceMessages(messages: AgentMessage[]): void;
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

const PROMPT_MUTATION_CORRECTION = "The user requested an actual rewrite of the current Forge prompt, but no edit_prompt call has succeeded. Do not finish with advice or claim the prompt changed. Read the current prompt again if needed. For deduplication, sorting, normalization, validation, or pool composition, call prompt_toolkit on the exact current prompt and pass its recommended_patch to edit_prompt. Then call edit_prompt with the latest base_hash and corrected arguments. Finish only after edit_prompt succeeds; if Forge reports a non-retryable blocker, explain that blocker clearly.";
const MAX_PROMPT_MUTATION_CORRECTIONS = 2;
const BACKGROUND_LOOKUP_CORRECTION = "The user asked for background information about a named entity. Your previous text-only answer is not acceptable and must not be shown. Character trigger words are stored in Forge style templates: first call search_resources with kind=style and the entity as query, then inspect_resource with kind=style for the best matching ID. If no style matches, fall back to inspect_danbooru_tags with include_wiki=true or search_danbooru_tags. Do not claim who or what the entity is from memory. Only answer after a successful inspection, and identify whether the source was a local Forge style or Danbooru.";
const MAX_BACKGROUND_LOOKUP_CORRECTIONS = 2;
type BackgroundLookupStage = "style-search" | "style-inspect" | "danbooru";

function isControlMessage(message: AgentMessage): message is PromptAgentControlMessage {
  return message.role === "promptAgentControl";
}

function normalizeControlMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => isControlMessage(message)
    ? { role: "user", content: message.content, timestamp: message.timestamp }
    : message);
}

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return normalizeControlMessages(messages).filter((message): message is Message => (
    message.role === "user" || message.role === "assistant" || message.role === "toolResult"
  ));
}

export class PiPromptAgentRuntime implements PromptAgentRuntime {
  private readonly agent: Agent;
  private readonly listeners = new Set<RuntimeListener>();
  private readonly unsubscribeAgent: () => void;
  private state: AgentRuntimeState = initialAgentRuntimeState();
  private destroyed = false;
  private abortRequested = false;
  private promptMutationRequired = false;
  private promptMutationSucceeded = false;
  private promptMutationCorrections = 0;
  private promptToolkitRequired = false;
  private promptToolkitSucceeded = false;
  private backgroundLookupRequired = false;
  private backgroundLookupSucceeded = false;
  private backgroundLookupCorrections = 0;
  private backgroundLookupStage: BackgroundLookupStage = "style-search";
  private lastTurnHadToolError = false;
  private readonly suppressedAssistantTimestamps = new Set<number>();

  constructor(options: PromptAgentRuntimeOptions) {
    this.agent = new Agent({
      initialState: {
        model: options.model,
        systemPrompt: options.systemPrompt ?? "Forge context is available through tools. Read current state before every mutation and use the returned hash for writes.",
        messages: options.messages ?? [],
        tools: options.tools ?? [],
        thinkingLevel: options.thinkingLevel ?? "off",
      },
      streamFn: options.streamFn
        ? (model, context, streamOptions) => options.streamFn!(model, context, {
          ...streamOptions,
          toolChoice: this.requiredBackgroundTool(),
        } as typeof streamOptions)
        : undefined,
      convertToLlm: options.convertToLlm
        ? (messages) => options.convertToLlm!(normalizeControlMessages(messages))
        : defaultConvertToLlm,
      transformContext: options.transformContext
        ? (messages, signal) => options.transformContext!(normalizeControlMessages(messages), signal)
        : undefined,
      beforeToolCall: async (context, signal) => {
        if (context.toolCall.name === "edit_prompt" && this.promptToolkitRequired && !this.promptToolkitSucceeded) {
          return { block: true, reason: "This prompt cleanup requires prompt_toolkit first. Read the exact current prompt, run the requested deterministic toolkit action, then pass recommended_patch to edit_prompt." };
        }
        return options.beforeToolCall?.(context, signal);
      },
      afterToolCall: options.afterToolCall,
      toolExecution: "sequential",
    });
    this.state = this.snapshot("idle");
    this.unsubscribeAgent = this.agent.subscribe((event) => {
      let status: AgentRuntimeStatus = this.state.status;
      if (event.type === "agent_start") status = "submitting";
      if (event.type === "turn_start" && this.lastTurnHadToolError) {
        status = "retrying";
        this.lastTurnHadToolError = false;
      }
      if (event.type === "message_update") status = "streaming";
      if (event.type === "tool_execution_start" || event.type === "tool_execution_update") status = "tool-calling";
      if (event.type === "tool_execution_end") {
        if (event.toolName === "prompt_toolkit" && !event.isError) this.promptToolkitSucceeded = true;
        if (event.toolName === "edit_prompt" && !event.isError) this.promptMutationSucceeded = true;
        if (!event.isError) this.recordBackgroundLookup(event.toolName, event.result.details);
        if (event.isError) this.lastTurnHadToolError = true;
      }
      if (event.type === "turn_end"
        && event.message.role === "assistant"
        && event.message.stopReason !== "error"
        && event.message.stopReason !== "aborted"
        && event.toolResults.length === 0
        && this.promptMutationRequired
        && !this.promptMutationSucceeded) {
        this.suppressedAssistantTimestamps.add(event.message.timestamp);
        if (this.promptMutationCorrections < MAX_PROMPT_MUTATION_CORRECTIONS) {
          this.promptMutationCorrections += 1;
          this.agent.followUp({ role: "promptAgentControl", content: PROMPT_MUTATION_CORRECTION, timestamp: Date.now() });
          status = "retrying";
        }
      }
      if (event.type === "turn_end"
        && event.message.role === "assistant"
        && event.message.stopReason !== "error"
        && event.message.stopReason !== "aborted"
        && event.toolResults.length === 0
        && !this.backgroundLookupSucceeded
        && this.backgroundLookupRequired) {
        this.suppressedAssistantTimestamps.add(event.message.timestamp);
        if (this.backgroundLookupCorrections < MAX_BACKGROUND_LOOKUP_CORRECTIONS) {
          this.backgroundLookupCorrections += 1;
          this.agent.followUp({ role: "promptAgentControl", content: BACKGROUND_LOOKUP_CORRECTION, timestamp: Date.now() });
          status = "retrying";
        }
      }
      if (event.type === "agent_end") status = this.agent.state.errorMessage ? "failed" : "completed";
      this.state = this.snapshot(status);
      this.emit();
    });
  }

  async submit(input: AgentInput): Promise<void> {
    this.assertAlive();
    this.abortRequested = false;
    this.promptMutationRequired = input.requirePromptMutation === true;
    this.promptMutationSucceeded = false;
    this.promptMutationCorrections = 0;
    this.promptToolkitRequired = input.requirePromptToolkit === true;
    this.promptToolkitSucceeded = false;
    this.backgroundLookupRequired = input.requireBackgroundLookup === true;
    this.backgroundLookupSucceeded = false;
    this.backgroundLookupCorrections = 0;
    this.backgroundLookupStage = "style-search";
    this.lastTurnHadToolError = false;
    this.suppressedAssistantTimestamps.clear();
    this.state = { ...this.snapshot("submitting"), error: undefined };
    this.emit();
    try {
      if (input.reasoningLevel) this.agent.state.thinkingLevel = input.reasoningLevel;
      await this.agent.prompt(input.text, input.images);
      this.agent.state.messages = this.visibleMessages();
      if (!this.agent.state.errorMessage && this.promptMutationRequired && !this.promptMutationSucceeded) {
        this.state = {
          ...this.snapshot("failed"),
          error: {
            code: "prompt_mutation_incomplete",
            message: "Prompt Agent could not complete the requested Forge prompt rewrite after corrective retries.",
            retryable: true,
          },
        };
      } else if (!this.agent.state.errorMessage && this.backgroundLookupRequired && !this.backgroundLookupSucceeded) {
        this.state = {
          ...this.snapshot("failed"),
          error: {
            code: "background_lookup_incomplete",
            message: "Prompt Agent could not verify the requested background information through a lookup tool.",
            retryable: true,
          },
        };
      } else {
        this.state = this.snapshot(this.agent.state.errorMessage ? "failed" : "completed");
      }
    } catch (error) {
      this.agent.state.messages = this.visibleMessages();
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

  replaceMessages(messages: AgentMessage[]): void {
    this.assertAlive();
    if (this.agent.state.isStreaming) throw new Error("Cannot replace messages while Prompt Agent is running");
    this.abortRequested = false;
    this.promptMutationRequired = false;
    this.promptMutationSucceeded = false;
    this.promptMutationCorrections = 0;
    this.promptToolkitRequired = false;
    this.promptToolkitSucceeded = false;
    this.backgroundLookupRequired = false;
    this.backgroundLookupSucceeded = false;
    this.backgroundLookupCorrections = 0;
    this.backgroundLookupStage = "style-search";
    this.lastTurnHadToolError = false;
    this.suppressedAssistantTimestamps.clear();
    this.agent.reset();
    this.agent.state.messages = messages;
    this.state = this.snapshot("idle");
    this.emit();
  }

  reset(): void {
    this.assertAlive();
    this.abortRequested = false;
    this.promptMutationRequired = false;
    this.promptMutationSucceeded = false;
    this.promptMutationCorrections = 0;
    this.promptToolkitRequired = false;
    this.promptToolkitSucceeded = false;
    this.backgroundLookupRequired = false;
    this.backgroundLookupSucceeded = false;
    this.backgroundLookupCorrections = 0;
    this.backgroundLookupStage = "style-search";
    this.lastTurnHadToolError = false;
    this.suppressedAssistantTimestamps.clear();
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
    return this.visibleMessages();
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
    const currentAssistantMessage = this.agent.state.streamingMessage;
    return {
      status,
      messages: this.visibleMessages(),
      currentAssistantMessage: currentAssistantMessage && this.isVisibleMessage(currentAssistantMessage)
        ? currentAssistantMessage
        : undefined,
      pendingToolCalls: [...this.agent.state.pendingToolCalls],
      error: errorMessage
        ? { code: this.abortRequested ? "runtime_aborted" : "provider_error", message: errorMessage, retryable: true }
        : undefined,
    };
  }

  private visibleMessages(): AgentMessage[] {
    return this.agent.state.messages.filter((message) => this.isVisibleMessage(message));
  }

  private isVisibleMessage(message: AgentMessage): boolean {
    return !isControlMessage(message)
      && !(message === this.agent.state.streamingMessage && this.backgroundLookupRequired && !this.backgroundLookupSucceeded)
      && !(message.role === "assistant" && this.suppressedAssistantTimestamps.has(message.timestamp));
  }

  private requiredBackgroundTool(): string | undefined {
    if (!this.backgroundLookupRequired || this.backgroundLookupSucceeded) return undefined;
    if (this.backgroundLookupStage === "style-search") return "search_resources";
    if (this.backgroundLookupStage === "style-inspect") return "inspect_resource";
    return "inspect_danbooru_tags";
  }

  private recordBackgroundLookup(toolName: string, details: unknown): void {
    if (!this.backgroundLookupRequired || !details || typeof details !== "object") return;
    const result = details as Record<string, unknown>;
    if (toolName === "search_resources" && result.kind === "style") {
      this.backgroundLookupStage = Array.isArray(result.items) && result.items.length > 0 ? "style-inspect" : "danbooru";
      return;
    }
    if (toolName === "inspect_resource" && result.kind === "style" && result.ok === true) {
      this.backgroundLookupSucceeded = true;
      return;
    }
    if (["inspect_danbooru_tags", "search_danbooru_tags", "related_danbooru_tags"].includes(toolName) && result.ok === true) {
      this.backgroundLookupSucceeded = true;
    }
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("PromptAgentRuntime has been destroyed");
  }
}
