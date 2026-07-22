import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message } from "@earendil-works/pi-ai";
import type {
  ChatAttachment,
  ChatMessage,
  HistoryRow,
  PromptAgentActionHandlers,
  MessageSubmission,
  Profile,
  SendMessageInput,
  PromptMutationEvidence,
} from "../contracts";
import { providerRegistry } from "../providers/registry";
import { supportsAgentChat } from "../providers/profile-capabilities";
import { PromptAgentSessionRepository } from "../sessions/repository";
import type { SessionSyncResult } from "../sessions/sync";
import type { PromptAgentMessage, PromptAgentSession, SessionMessageStatus } from "../sessions/schema";
import { useChatStore } from "../stores/chat";
import { useProfileStore } from "../stores/profiles";
import { useRuntimeStore, type WorkingPhase } from "../stores/runtime";
import { PiPromptAgentRuntime, type PromptAgentRuntime } from "./agent-runtime";
import type { AgentRuntimeState } from "./runtime-state";
import { createForgeToolRegistry } from "../tools/tool-registry";
import { getHostApi, promptAgentNamespace } from "../bridge";
import { startLocalRuntime, stopLocalRuntime } from "../profile-api";
import { diffPromptText } from "../prompts/prompt-diff";

const LAST_SESSION_PREFERENCE = "last-session-id";
export const FORGE_AGENT_SYSTEM_PROMPT = "You are the SD Forge Neo Prompt Agent. The target image model accepts hybrid prompts: natural-language descriptions and Danbooru-style tags are both first-class and may be combined. Keep natural-language blocks, tags, special syntax, and unknown fragments independent; do not force natural language into tags or split coherent prose at every comma. Use natural language for relationships, spatial detail, scene intent, and atmosphere; use tags for precise visual attributes and concise controls. Do not convert between pools unless the user asks. Forge state is live context: select the positive or negative field when reading/editing prompts, read prompts or generation parameters before changing them, use the returned latest hash/context hash, and make only bounded visible-control changes. read_prompt reports whether negative prompting is enabled. Text in a disabled negative field is editable but not effective: never claim exclusions are active, never silently enable CFG, and state clearly when text changed but remains inactive. For prompt deduplication, sorting, normalization, validation, or pool composition, call prompt_toolkit on the exact text returned by read_prompt, then pass its recommended_patch to edit_prompt. Sorting normally affects only the tag pool; preserve NL order and BREAK/AND groups. For non-empty prompts use patches or diff; full prompt overwrite is allowed only when the field is empty. When a tool returns an error, treat it as feedback instead of ending the task: correct the arguments or refresh stale Forge state with the matching read tool, then retry when safe. Never repeat an identical failed write blindly; if the error is not recoverable, explain the blocker. Continue until the user's requested rewrite or change is completed. Character trigger words and templates are stored in Forge styles. When the user asks who or what a named entity is, or asks for background information, first call search_resources with kind=style and the entity query; inspect the best matching style with inspect_resource before answering. Only if no style matches may you fall back to Danbooru tag/wiki tools. Never answer that question from memory or invent an identity, and state whether the answer came from a local Forge style or Danbooru. Prefer search_danbooru_tags for unfamiliar visual tag concepts. Never request paths or provider credentials.";
type SessionRepository = Pick<PromptAgentSessionRepository,
  "putSession" | "getSession" | "listSessions" | "putMessage" | "getMessages" | "deleteMessages" |
  "putPreference" | "getPreference" | "markInterrupted"> & { syncWithServer?: () => Promise<SessionSyncResult> };

export class PromptAgentController {
  readonly actions: PromptAgentActionHandlers;
  private runtime: PromptAgentRuntime | null = null;
  private unsubscribeRuntime: (() => void) | null = null;
  private currentSession: PromptAgentSession | null = null;
  private interruptedRecords: PromptAgentMessage[] = [];
  private requestId: string | null = null;
  private localRuntimeProfileId: string | null = null;
  private localRuntimeStartController: AbortController | null = null;
  private forceLocalRuntimeStop = false;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private mounted = false;
  private destroyed = false;

  constructor(
    private readonly sessions: SessionRepository = new PromptAgentSessionRepository(),
    private readonly options: { allowForgeWrites?: () => boolean } = {},
  ) {
    this.actions = {
      sendMessage: (input) => this.sendMessage(input),
      stopRequest: () => this.stopRequest(),
      attachFiles: () => undefined,
      replaceAttachment: () => undefined,
      removeAttachment: () => undefined,
      readPrompt: () => undefined,
      clearChat: () => this.newSession(),
      copyMessage: async (message) => navigator.clipboard?.writeText(message.content),
      undoToolMutation: async () => { throw new Error("No Forge mutation is available to undo."); },
      selectHistory: (row) => this.selectHistory(row),
      newSession: () => this.newSession(),
      openSettings: () => undefined,
    };
  }

  async mount(): Promise<void> {
    if (this.mounted) return;
    this.assertAlive();
    this.mounted = true;
    useRuntimeStore.getState().setStartup("starting");
    try {
      await this.sessions.markInterrupted();
      await this.loadProfiles();
      await this.syncSessionsBestEffort();
      const sessions = await this.sessions.listSessions();
      const lastSessionId = await this.sessions.getPreference<string>(LAST_SESSION_PREFERENCE);
      const selected = sessions.find((session) => session.id === lastSessionId) ?? sessions[0];
      if (selected) await this.openSession(selected);
      else await this.newSession();
      await this.loadHistory();
      useRuntimeStore.getState().setStartup("ready");
    } catch (error) {
      useRuntimeStore.getState().setStartup("error");
      useRuntimeStore.getState().setError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.forceLocalRuntimeStop = true;
    this.localRuntimeStartController?.abort();
    if (this.localRuntimeProfileId && this.requestId) void stopLocalRuntime(this.localRuntimeProfileId, this.requestId, true).catch(() => undefined);
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.runtime?.destroy();
    this.runtime = null;
    useChatStore.getState().setActiveRequest(null);
    useRuntimeStore.getState().setWorking("idle");
  }

  async loadHistory(): Promise<HistoryRow[]> {
    const sessions = await this.sessions.listSessions();
    const rows = await Promise.all(sessions.map(async (session) => {
      const messages = await this.sessions.getMessages(session.id);
      const preview = messages.find((message) => message.message.role === "user");
      return {
        id: session.id,
        source: "prompt-agent" as const,
        title: session.title,
        preview: preview ? messageText(preview.message) : "",
        updatedAt: new Date(session.updatedAt).toLocaleString(),
        messageCount: messages.length,
      };
    }));
    useRuntimeStore.getState().setHistory(rows);
    return rows;
  }

  async selectHistory(row: HistoryRow): Promise<void> {
    const session = await this.sessions.getSession(row.id);
    if (!session) throw new Error("The selected session is unavailable.");
    await this.openSession(session);
  }

  async newSession(): Promise<void> {
    this.assertAlive();
    this.runtime?.abort();
    const profile = activeProfile();
    const now = Date.now();
    const session: PromptAgentSession = {
      id: crypto.randomUUID(),
      title: "New conversation",
      createdAt: now,
      updatedAt: now,
      profileId: profile.id,
      providerId: providerId(profile),
      modelId: profile.modelId,
      reasoningLevel: profile.parameters.reasoningEffort,
      systemPrompt: "",
      schemaVersion: 1,
    };
    await this.sessions.putSession(session);
    await this.openSession(session);
    await this.syncSessionsBestEffort();
    await this.loadHistory();
  }

  private async sendMessage(input: SendMessageInput): Promise<MessageSubmission> {
    this.assertAlive();
    if (!this.currentSession || !this.runtime) throw new Error("Prompt Agent is not ready.");
    if (this.requestId) throw new Error("A response is already being generated.");
    await this.refreshRuntimeProfile();
    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    useChatStore.getState().setActiveRequest(requestId);
    const images = input.attachments.map(toImageContent);
    const reasoningLevel = input.reasoning === "none" || input.reasoning === "max" ? (input.reasoning === "none" ? "off" : "xhigh") : input.reasoning;
    const profile = profileById(this.currentSession.profileId) ?? activeProfile();
    const localStartController = new AbortController();
    const usesLocalRuntime = profile.runtime === "llama-once";
    if (usesLocalRuntime) {
      this.localRuntimeProfileId = profile.id;
      this.localRuntimeStartController = localStartController;
      this.forceLocalRuntimeStop = false;
    }
    try {
      if (usesLocalRuntime) await startLocalRuntime(profile.id, requestId, localStartController.signal);
      const editedFirstUser = input.editOf ? await this.rewindForEdit(input.editOf) : false;
      const requirePromptToolkit = userRequestedPromptToolkit(input.text);
      await this.runtime.submit({
        text: input.text,
        images,
        reasoningLevel,
        requirePromptMutation: requirePromptToolkit || userRequestedPromptMutation(input.text),
        requirePromptToolkit,
        requireBackgroundLookup: userRequestedBackgroundLookup(input.text),
      });
      await this.queueRuntimePersistence(this.runtime.getState(), this.currentSession.id);
      await this.touchSession(input.text, editedFirstUser);
      await this.loadHistory();
      return { kind: "local", id: requestId };
    } finally {
      if (usesLocalRuntime) {
        try { await stopLocalRuntime(profile.id, requestId, this.forceLocalRuntimeStop); }
        catch (error) { useRuntimeStore.getState().setError(error instanceof Error ? error.message : String(error)); }
      }
      if (this.localRuntimeStartController === localStartController) this.localRuntimeStartController = null;
      if (this.localRuntimeProfileId === profile.id) this.localRuntimeProfileId = null;
      this.forceLocalRuntimeStop = false;
      this.requestId = null;
      useChatStore.getState().setActiveRequest(null);
      useRuntimeStore.getState().setWorking("idle");
      await this.persistenceQueue.catch(() => undefined);
      await this.syncSessionsBestEffort();
    }
  }

  private async refreshRuntimeProfile(): Promise<void> {
    if (!this.currentSession) return;
    const profile = activeProfile();
    this.currentSession = {
      ...this.currentSession,
      profileId: profile.id,
      providerId: providerId(profile),
      modelId: profile.modelId,
      reasoningLevel: profile.parameters.reasoningEffort,
      updatedAt: Date.now(),
    };
    await this.sessions.putSession(this.currentSession);
    await this.openSession(this.currentSession);
  }

  private stopRequest(): void {
    if (!this.runtime || !this.requestId) return;
    useRuntimeStore.getState().setWorking("cancelling");
    this.forceLocalRuntimeStop = true;
    this.localRuntimeStartController?.abort();
    if (this.localRuntimeProfileId) void stopLocalRuntime(this.localRuntimeProfileId, this.requestId, true).catch(() => undefined);
    this.runtime.abort();
  }

  private async openSession(session: PromptAgentSession): Promise<void> {
    this.unsubscribeRuntime?.();
    this.runtime?.destroy();
    this.currentSession = session;
    await this.sessions.putPreference(LAST_SESSION_PREFERENCE, session.id);
    const records = await this.sessions.getMessages(session.id);
    this.interruptedRecords = records.filter((record) => record.status !== "complete");
    const messages = records.filter((record) => record.status === "complete").map((record) => record.message);
    const profile = profileById(session.profileId) ?? activeProfile();
    const provider = providerRegistry.resolve({
      id: profile.id,
      providerId: providerId(profile),
      protocol: profile.protocol,
      runtime: profile.runtime,
      endpoint: profile.endpoint,
      modelInfo: { providerId: profile.modelInfo.providerId },
      capabilities: profile.capabilities,
    });
    const toolRegistry = createForgeToolRegistry({
      host: () => getHostApi(typeof window === "undefined" ? undefined : promptAgentNamespace(window)),
      allowWrites: this.options.allowForgeWrites ?? (() => true),
    });
    const model = provider.toPiModel({
      id: profile.modelId,
      profileId: profile.id,
      providerId: provider.id,
      displayName: profile.displayName,
      capabilities: provider.effectiveCapabilities(profile),
      contextWindow: profile.modelInfo.contextLimit || profile.nCtx || 131072,
      maxTokens: profile.parameters.maxTokens,
    });
    this.runtime = new PiPromptAgentRuntime({
      model,
      systemPrompt: [FORGE_AGENT_SYSTEM_PROMPT, session.systemPrompt.trim()].filter(Boolean).join("\n\n"),
      messages,
      tools: toolRegistry.list(),
      thinkingLevel: normalizedThinking(session.reasoningLevel),
      streamFn: provider.createStream(profile.id, () => this.requestId ?? "", ({ attempt, maxAttempts, statusCode }) => {
        const status = statusCode ? ` after HTTP ${statusCode}` : " after a network error";
        useRuntimeStore.getState().setWorking("retrying", `Provider request ${attempt}/${maxAttempts}${status}`);
      }),
    });
    const sessionId = session.id;
    this.unsubscribeRuntime = this.runtime.subscribe((state) => {
      this.projectRuntimeState(state);
      void this.queueRuntimePersistence(state, sessionId).catch((error) => {
        useRuntimeStore.getState().setError(error instanceof Error ? error.message : String(error));
      });
    });
    useRuntimeStore.getState().setSession({ session_id: session.id, profile_id: session.profileId });
    this.projectRuntimeState(this.runtime.getState());
  }

  private projectRuntimeState(state: AgentRuntimeState): void {
    const records = [...this.interruptedRecords, ...runtimeRecords(this.currentSession?.id ?? "", state)];
    records.sort((left, right) => left.createdAt - right.createdAt);
    useChatStore.getState().setMessages(records.map(toChatMessage));
    useRuntimeStore.getState().setError(state.error?.message ?? null);
    const phase = workingPhase(state);
    useRuntimeStore.getState().setWorking(
      phase,
      phase === "retrying" ? null : state.pendingToolCalls[0] ?? null,
    );
  }

  private queueRuntimePersistence(state: AgentRuntimeState, sessionId: string): Promise<void> {
    const queued = this.persistenceQueue.catch(() => undefined).then(() => this.persistRuntimeState(state, sessionId));
    this.persistenceQueue = queued;
    return queued;
  }

  private async persistRuntimeState(state: AgentRuntimeState, sessionId: string): Promise<void> {
    const records = runtimeRecords(sessionId, state);
    if (["retrying", "completed", "failed"].includes(state.status)) {
      const recordIds = new Set(records.map((record) => record.id));
      const obsoleteIds = (await this.sessions.getMessages(sessionId))
        .filter((record) => record.status === "complete" && !recordIds.has(record.id))
        .map((record) => record.id);
      if (obsoleteIds.length) await this.sessions.deleteMessages(obsoleteIds);
    }
    await Promise.all(records.map((record) => this.sessions.putMessage(record)));
  }

  private async rewindForEdit(messageId: string): Promise<boolean> {
    if (!this.currentSession || !this.runtime) throw new Error("Prompt Agent is not ready.");
    await this.persistenceQueue.catch(() => undefined);
    const records = await this.sessions.getMessages(this.currentSession.id);
    const targetIndex = records.findIndex((record) => record.id === messageId);
    const target = records[targetIndex];
    if (targetIndex < 0 || !target || target.status !== "complete" || target.message.role !== "user") {
      throw new Error("This user message is no longer available to edit.");
    }
    const firstUserId = records.find((record) => record.status === "complete" && record.message.role === "user")?.id;
    await this.sessions.deleteMessages(records.slice(targetIndex).map((record) => record.id));
    const retained = records.slice(0, targetIndex);
    this.interruptedRecords = retained.filter((record) => record.status !== "complete");
    this.runtime.replaceMessages(retained.filter((record) => record.status === "complete").map((record) => record.message));
    return firstUserId === messageId;
  }

  private async touchSession(firstUserText: string, replaceTitle = false): Promise<void> {
    if (!this.currentSession) return;
    const title = (replaceTitle || this.currentSession.title === "New conversation") && firstUserText.trim()
      ? firstUserText.trim().replace(/\s+/g, " ").slice(0, 64)
      : this.currentSession.title;
    this.currentSession = { ...this.currentSession, title, updatedAt: Date.now() };
    await this.sessions.putSession(this.currentSession);
  }

  private async loadProfiles(): Promise<void> {
    const response = await fetch("/prompt-agent/api/profiles", { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Prompt Agent profiles failed with HTTP ${response.status}`);
    useProfileStore.getState().setState(await response.json());
  }

  private async syncSessionsBestEffort(): Promise<void> {
    if (!this.sessions.syncWithServer) return;
    try {
      const result = await this.sessions.syncWithServer();
      const activeId = this.currentSession?.id;
      const conflict = result.conflicts.find((item) => item.session_id === activeId);
      const selectedId = conflict?.conflict_session_id ?? activeId;
      if (selectedId) {
        const synchronized = await this.sessions.getSession(selectedId);
        if (synchronized) {
          if (conflict) await this.openSession(synchronized);
          else this.currentSession = synchronized;
        }
      }
    } catch (error) {
      console.warn("Prompt Agent session sync is temporarily unavailable", error);
    }
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("PromptAgentController has been destroyed");
  }
}

const activeProfile = (): Profile => {
  const state = useProfileStore.getState();
  const profile = state.profiles.find((item) => item.id === state.activeProfileId && item.enabled && supportsAgentChat(item));
  if (!profile) throw new Error("Select an enabled model profile before sending a message.");
  return profile;
};

const profileById = (id: string): Profile | undefined => useProfileStore.getState().profiles.find((profile) => profile.id === id && profile.enabled);

const abortableDelay = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(signal.reason);
    return;
  }
  const onAbort = () => {
    window.clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = window.setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, milliseconds);
  signal.addEventListener("abort", onAbort, { once: true });
});

const providerId = (profile: Profile): string => profile.providerId || (profile.runtime.startsWith("llama") ? "llama-cpp" : profile.protocol === "gemini-native" ? "gemini" : "openai-compatible");

const normalizedThinking = (value: string): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" => {
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  return value === "max" ? "xhigh" : "off";
};

const toImageContent = (attachment: { dataUrl: string; mimeType?: string }): ImageContent => {
  const match = attachment.dataUrl.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!match) throw new Error("Attachment data must be a base64 data URL.");
  return { type: "image", mimeType: attachment.mimeType || match[1], data: match[2] };
};

function runtimeRecords(sessionId: string, state: AgentRuntimeState): PromptAgentMessage[] {
  const messages = [...state.messages];
  if (state.currentAssistantMessage && !messages.includes(state.currentAssistantMessage)) messages.push(state.currentAssistantMessage);
  return messages.map((message) => ({
    id: messageId(sessionId, message),
    sessionId,
    message,
    status: messageStatus(message, state),
    createdAt: message.timestamp,
    updatedAt: Date.now(),
  }));
}

const messageId = (sessionId: string, message: AgentMessage): string => `${sessionId}:${message.role}:${message.timestamp}`;

function messageStatus(message: AgentMessage, state: AgentRuntimeState): SessionMessageStatus {
  if (message === state.currentAssistantMessage && ["submitting", "streaming", "tool-calling", "retrying", "aborting"].includes(state.status)) return "streaming";
  if (message.role === "assistant" && message.stopReason === "error") return "failed";
  if (message.role === "assistant" && message.stopReason === "aborted") return "interrupted";
  return "complete";
}

function toChatMessage(record: PromptAgentMessage): ChatMessage {
  const message = record.message;
  const role: ChatMessage["role"] = message.role === "user"
    ? "user"
    : message.role === "assistant"
      ? "assistant"
      : message.role === "toolResult"
        ? "tool"
        : "system";
  const status = record.status === "streaming" ? "streaming" : record.status === "failed" ? "error" : record.status === "interrupted" ? "cancelled" : "complete";
  const attachments = message.role === "user" ? attachmentsFromMessage(message) : [];
  const reasoning = message.role === "assistant" ? message.content.filter((block) => block.type === "thinking").map((block) => block.thinking).join("\n") : undefined;
  const toolName = message.role === "toolResult" ? message.toolName : undefined;
  const mutation = message.role === "toolResult" && !message.isError && toolName === "edit_prompt" ? promptMutationEvidence(message) : undefined;
  const toolDetail = mutation
    ? mutationDetail(mutation)
    : message.role === "toolResult" && toolName === "prompt_toolkit"
      ? promptToolkitDetail(message)
      : undefined;
  return {
    id: record.id,
    role,
    content: messageText(message),
    status,
    reasoning,
    usage: message.role === "assistant" ? { inputTokens: message.usage.input, outputTokens: message.usage.output, totalTokens: message.usage.totalTokens } : undefined,
    tool: toolName ? { name: toolName, status: message.role === "toolResult" && message.isError ? "error" : "complete", detail: toolDetail, mutation } : undefined,
    attachments,
    createdAt: message.timestamp,
  };
}

function toolResultDetails(message: Extract<AgentMessage, { role: "toolResult" }>): Record<string, unknown> | null {
  const direct = (message as unknown as { details?: unknown }).details;
  if (direct && typeof direct === "object") return direct as Record<string, unknown>;
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch (_error) {
    return null;
  }
}

function promptMutationEvidence(message: Extract<AgentMessage, { role: "toolResult" }>): PromptMutationEvidence | undefined {
  const result = toolResultDetails(message);
  if (!result || result.ok !== true || typeof result.before_prompt !== "string" || typeof result.after_prompt !== "string") return undefined;
  const diff = diffPromptText(result.before_prompt, result.after_prompt);
  const target = result.target === "txt2img" || result.target === "img2img" ? result.target : "active";
  const field = result.field === "negative" ? "negative" : "positive";
  const fieldEnabled = typeof result.field_enabled === "boolean" ? result.field_enabled : null;
  const effective = typeof result.effective === "boolean" ? result.effective : field === "positive" ? fieldEnabled !== false : fieldEnabled;
  return {
    version: 1,
    target,
    field,
    beforeHash: typeof result.before_hash === "string" ? result.before_hash : "",
    afterHash: typeof result.prompt_hash === "string" ? result.prompt_hash : "",
    fieldEnabled,
    effective,
    ...(typeof result.negative_inactive_reason === "string" && result.negative_inactive_reason ? { inactiveReason: result.negative_inactive_reason } : {}),
    changes: diff.changes,
    summary: diff.summary,
    ...(diff.truncated ? { truncated: true } : {}),
  };
}

function mutationDetail(mutation: PromptMutationEvidence): string {
  const field = mutation.field === "negative" ? "Negative prompt" : "Positive prompt";
  const effect = mutation.field === "negative" && mutation.effective === false ? " · disabled" : "";
  return `${field} updated${effect} · +${mutation.summary.added} -${mutation.summary.removed} ↕${mutation.summary.moved}`;
}

function promptToolkitDetail(message: Extract<AgentMessage, { role: "toolResult" }>): string | undefined {
  const result = toolResultDetails(message);
  if (!result || result.ok !== true) return undefined;
  const summary = result.summary && typeof result.summary === "object" ? result.summary as Record<string, unknown> : {};
  return `Prompt ${String(result.action || "analyzed")} · +${Number(summary.added || 0)} -${Number(summary.removed || 0)} ↕${Number(summary.moved || 0)}`;
}

function messageText(message: AgentMessage): string {
  if (message.role === "user") return typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  if (message.role === "assistant") return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") || message.errorMessage || "";
  if (message.role === "toolResult") return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  return "";
}

function attachmentsFromMessage(message: Extract<Message, { role: "user" }>): ChatAttachment[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((block, index) => block.type === "image" ? [{
    id: `restored-${message.timestamp}-${index}`,
    name: `reference-${index + 1}`,
    dataUrl: `data:${block.mimeType};base64,${block.data}`,
    mimeType: block.mimeType,
  }] : []);
}

function workingPhase(state: AgentRuntimeState): WorkingPhase {
  if (state.status === "submitting") return "submitting";
  if (state.status === "streaming") return "generating";
  if (state.status === "tool-calling") return "tool";
  if (state.status === "retrying") return "retrying";
  if (state.status === "aborting") return "cancelling";
  return "idle";
}

export function userRequestedPromptMutation(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!value) return false;
  const editVerb = /(改成|修改|改写|重写|优化|精炼|扩写|替换|追加|加上|加入|删除|移除|写入|更新|套用|应用|编辑|修一下|insert|append|replace|rewrite|edit|update|apply|change|remove|delete|optimi[sz]e|refine|expand)/i;
  const promptReference = /(当前|现在|现有|原来|原有|这个|这段|它|其|提示词|prompt|txt2img|img2img|webui|ui|输入框|文本框)/i;
  const directEdit = /(帮我|请|直接|把|将|给我|给[\w\u4e00-\u9fff -]{1,40}).{0,30}(改成|修改|改写|重写|优化|精炼|扩写|替换|追加|加上|加入|删除|移除|写入|更新|套用|应用|编辑|修一下)/i;
  const adviceOnly = /(怎么改|如何改|哪里.*改|修改建议|改进建议|优化建议|建议.*(修改|优化|改写|调整)|should.*(change|edit|rewrite)|how.*(change|edit|rewrite))/i;
  return editVerb.test(value) && !adviceOnly.test(value) && (promptReference.test(value) || directEdit.test(value));
}

export function userRequestedPromptToolkit(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!value) return false;
  const toolkitIntent = /(去重|去重复|删除重复|移除重复|排序|重新排列|整理标签|规范化|格式化|检查重复|检查语法|拆分.*(?:自然语言|标签|tag)|合并.*(?:提示词|prompt)|deduplicat|de-?duplicate|remove duplicates?|sort(?:ing)?|reorder|normali[sz]e|format prompt|validate prompt|split.*(?:pool|tags?)|compose prompt)/i;
  return toolkitIntent.test(value) && /(提示词|prompt|正向|负向|negative|positive|tag|标签|当前|现有|这段|它)/i.test(value);
}

export function userRequestedBackgroundLookup(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!value || /(提示词|prompt|txt2img|img2img|生成参数|generation parameter)/i.test(value)) return false;
  return /[^?？\s]{2,80}\s*是谁/i.test(value)
    || /(?:背景信息|背景资料|角色背景|人物资料|角色设定|人物设定|出处)/i.test(value)
    || /(?:查一下|查询|查查|搜索|了解一下).{0,80}(?:是谁|背景|资料|出处|设定|角色|人物)/i.test(value)
    || /\bwho\s+is\s+[^?]{2,80}/i.test(value)
    || /\b(?:background\s+(?:info|information)\s+(?:on|about)|look\s+up|research)\s+[^?]{2,80}/i.test(value);
}
