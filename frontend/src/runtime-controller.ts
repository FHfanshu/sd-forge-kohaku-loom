import type { LoomActionHandlers, ChatAttachment, ChatMessage, HistoryRow, Profile, QueuedMessage, SendMessageInput, BranchMetadata, BranchTurn, RuntimeSession, RiskMode } from "./contracts";
import { getHostApi, type KohakuLoomHostApi, type KohakuLoomNamespace } from "./bridge";
import { KTClient } from "./kt/client";
import { isAbortError } from "./kt/retry";
import { attachmentSchema, chatMessageSchema, queuedMessageSchema } from "./contracts";
import { useChatStore } from "./stores/chat";
import { useProfileStore } from "./stores/profiles";
import { useRuntimeStore } from "./stores/runtime";
import { useUiStore } from "./stores/ui";
import { normalizeProfile, normalizeProfileState } from "./profile-adapter";

type RawRecord = Record<string, any>;

interface LoomRun {
  requestId: string;
  controller: AbortController;
  turnId: string;
  turnCursor: number;
  toolCursor: number;
  bridgeId: string;
  text: string;
  reasoning: string;
  usage: unknown;
  assistantId: string | null;
  cancelled: boolean;
  finished: boolean;
  leaseTimer: ReturnType<typeof setInterval> | null;
  renderHandle: { kind: "animation"; id: number } | { kind: "timeout"; id: ReturnType<typeof setTimeout> } | null;
  toolResults: Map<string, unknown>;
  toolPromises: Map<string, Promise<unknown>>;
  activeTools: Map<string, string>;
  pendingTurnEvents: RawRecord[];
  resolve(value: RawRecord): void;
  done: Promise<RawRecord>;
}

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : {};
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.filter((part) => asRecord(part).type === "text").map((part) => String(asRecord(part).text ?? "")).join("\n");
}

function attachmentsFromContent(content: unknown): ChatAttachment[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part, index) => {
    const value = asRecord(part);
    const image = asRecord(value.image_url);
    if (value.type !== "image_url" || typeof image.url !== "string") return [];
    return [{
      id: `server-attachment-${index}-${String(image.url).slice(-12)}`,
      name: String(asRecord(value.meta).source_name ?? "reference image"),
      dataUrl: image.url,
    }];
  });
}

function attachmentsFromMessage(content: unknown, rawAttachments: unknown): ChatAttachment[] {
  const inline = attachmentsFromContent(content);
  if (inline.length || !Array.isArray(rawAttachments)) return inline;
  return rawAttachments.flatMap((item, index) => {
    const parsed = attachmentSchema.safeParse(item);
    if (parsed.success) return [parsed.data];
    const value = asRecord(item);
    const dataUrl = String(value.dataUrl ?? value.data_url ?? "");
    if (!dataUrl) return [];
    return [{
      id: String(value.id ?? `server-attachment-${index}`),
      name: String(value.name ?? "reference image"),
      dataUrl,
      mimeType: value.mimeType ? String(value.mimeType) : undefined,
      size: Number.isFinite(Number(value.size)) ? Number(value.size) : undefined,
    }];
  });
}

function usageFrom(value: unknown): ChatMessage["usage"] {
  const source = asRecord(asRecord(value).usage ?? value);
  const number = (candidate: unknown): number | undefined => {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const inputTokens = number(source.input_tokens ?? source.prompt_tokens);
  const outputTokens = number(source.output_tokens ?? source.completion_tokens);
  const totalTokens = number(source.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  const latencyMs = number(source.latency_ms ?? source.latencyMs);
  const durationSeconds = number(source.duration_s);
  const resolvedLatency = latencyMs ?? (durationSeconds === undefined ? undefined : Math.round(durationSeconds * 1000));
  if ([inputTokens, outputTokens, totalTokens, resolvedLatency].every((item) => item === undefined)) return undefined;
  return { inputTokens, outputTokens, totalTokens, latencyMs: resolvedLatency };
}

function branchForTurn(branches: BranchMetadata | null, turnIndex: number): { index: number; count: number } {
  const turn = branches?.turns?.find((item) => item.turnIndex === turnIndex);
  if (!turn) return { index: 0, count: 1 };
  const selected = turn.selectedBranchId ?? turn.latestBranch ?? turn.branches[0] ?? 0;
  const index = Math.max(0, turn.branches.indexOf(selected));
  return { index, count: Math.max(1, turn.branchCount || turn.branches.length) };
}

function normalizeBranchMetadata(value: unknown): BranchMetadata | null {
  const raw = asRecord(value);
  if (!Object.keys(raw).length) return null;
  const numberMap = (candidate: unknown): Record<string, number> => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
    return Object.fromEntries(Object.entries(candidate as RawRecord).flatMap(([key, item]) => {
      const parsed = Number(item);
      return Number.isFinite(parsed) ? [[key, parsed]] : [];
    }));
  };
  const turns: BranchTurn[] = Array.isArray(raw.turns) ? raw.turns.flatMap((item) => {
    const turn = asRecord(item);
    const turnIndex = Number(turn.turnIndex ?? turn.turn_index);
    const branches = Array.isArray(turn.branches) ? turn.branches.map(Number).filter(Number.isFinite) : [];
    if (!Number.isInteger(turnIndex) || !branches.length) return [];
    const statuses = asRecord(turn.branchStatuses ?? turn.branch_statuses);
    return [{
      turnIndex,
      branches,
      branchCount: Math.max(1, Number(turn.branchCount ?? turn.branch_count ?? branches.length)),
      latestBranch: Number.isFinite(Number(turn.latestBranch ?? turn.latest_branch)) ? Number(turn.latestBranch ?? turn.latest_branch) : undefined,
      selectedBranchId: Number.isFinite(Number(turn.selectedBranchId ?? turn.selected_branch_id)) ? Number(turn.selectedBranchId ?? turn.selected_branch_id) : undefined,
      branchStatuses: Object.fromEntries(Object.entries(statuses).map(([key, status]) => [key, String(status)])),
    }];
  }) : [];
  return {
    ...raw,
    session_id: raw.session_id ? String(raw.session_id) : undefined,
    branch_view: numberMap(raw.branch_view),
    selected_branch_ids: numberMap(raw.selected_branch_ids),
    branch_counts: numberMap(raw.branch_counts),
    latest_branch_ids: numberMap(raw.latest_branch_ids),
    branch_statuses: raw.branch_statuses,
    turns,
    final_turn_index: raw.final_turn_index === null || raw.final_turn_index === undefined ? raw.final_turn_index as number | null | undefined : Number(raw.final_turn_index),
  };
}

function mapConversationMessage(rawValue: unknown, index: number, branches: BranchMetadata | null, turnIndex: number): ChatMessage {
  const raw = asRecord(rawValue);
  const roleValue = String(raw.role ?? raw.event_type ?? "assistant").toLowerCase();
  const role = roleValue === "user" ? "user" : roleValue === "tool" ? "tool" : roleValue === "system" ? "system" : roleValue === "error" ? "error" : "assistant";
  const messageTurnIndex = Number(raw.turn_index ?? raw.turnIndex);
  const resolvedTurnIndex = Number.isInteger(messageTurnIndex) ? messageTurnIndex : turnIndex;
  const branch = role === "assistant" ? branchForTurn(branches, resolvedTurnIndex) : { index: 0, count: 1 };
  const rawStatus = String(raw.status ?? raw.state ?? "complete").toLowerCase();
  const status = rawStatus === "streaming" ? "streaming" : rawStatus === "cancelled" || rawStatus === "interrupted" ? "cancelled" : rawStatus === "error" || rawStatus === "failed" ? "error" : "complete";
  const tool = raw.tool || raw.tool_name ? {
    name: String(raw.tool?.name ?? raw.tool_name ?? raw.name ?? "tool"),
    status: rawStatus === "error" || rawStatus === "failed" ? "error" : "complete",
    detail: raw.tool?.detail ? String(raw.tool.detail) : undefined,
  } : undefined;
  return chatMessageSchema.parse({
    id: String(raw.id ?? raw.message_id ?? `server-message-${index}`),
    role,
    content: textFromContent(raw.content ?? raw.text ?? ""),
    status,
    reasoning: raw.reasoning ? String(raw.reasoning) : undefined,
    usage: usageFrom(raw.usage),
    tool,
    attachments: attachmentsFromMessage(raw.content, raw.attachments),
    branchIndex: branch.index,
    branchCount: branch.count,
    branchTurnIndex: role === "assistant" ? resolvedTurnIndex : undefined,
    createdAt: Math.max(0, Number(raw.created_at ?? raw.createdAt ?? Date.now()) || Date.now()),
  });
}

function mapQueuedMessage(rawValue: unknown): QueuedMessage {
  const raw = asRecord(rawValue);
  return queuedMessageSchema.parse({
    id: String(raw.message_id ?? raw.id),
    text: String(raw.display_content ?? textFromContent(raw.content ?? "")),
    attachments: Array.isArray(raw.attachments) ? raw.attachments : attachmentsFromContent(raw.content),
    state: raw.state,
    kind: raw.kind,
    error: raw.error ? String(raw.error) : undefined,
    turnId: raw.turn_id ? String(raw.turn_id) : undefined,
    sequence: Number.isFinite(Number(raw.sequence)) ? Number(raw.sequence) : undefined,
    updatedAt: Number.isFinite(Number(raw.updated_at)) ? Number(raw.updated_at) : undefined,
    createdAt: Math.max(0, Number(raw.created_at ?? Date.now()) || Date.now()),
  });
}

function mapProfile(rawValue: unknown): Profile {
  return normalizeProfile(rawValue);
}

function mapHistory(rawValue: unknown, source: "KT" | "legacy"): HistoryRow {
  const raw = asRecord(rawValue);
  const id = String(raw.session_id ?? raw.id);
  const modified = raw.modified_at ?? raw.updated_at ?? raw.created_at;
  const timestamp = typeof modified === "number" ? new Date(modified * (modified < 10_000_000_000 ? 1000 : 1)).toLocaleString() : String(modified ?? "");
  const suppliedTitle = String(raw.title ?? raw.name ?? "").trim();
  const title = suppliedTitle || (source === "legacy" ? "Legacy session" : "Untitled session");
  const preview = String(raw.preview ?? raw.description ?? raw.summary ?? "");
  return { id, source, title, preview, updatedAt: timestamp || "", messageCount: Math.max(0, Number(raw.message_count ?? raw.messageCount ?? 0) || 0) };
}

function contentForMessage(input: SendMessageInput): string | RawRecord[] {
  const parts: RawRecord[] = [];
  if (input.text) parts.push({ type: "text", text: input.text });
  input.attachments.forEach((attachment) => parts.push({
    type: "image_url",
    image_url: { url: attachment.dataUrl, detail: "high" },
    meta: { source_type: "attachment", source_name: attachment.name },
  }));
  return parts.length === 1 && parts[0].type === "text" ? input.text : parts;
}

function operationId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `svelte-ui:${prefix}:${random}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function adaptTool(toolValue: unknown): RawRecord {
  const tool = asRecord(toolValue);
  const name = String(tool.tool ?? tool.name ?? "");
  const args = asRecord(tool.arguments ?? tool.args ?? {});
  if (name === "forge_resource") {
    const action = String(args.action ?? "");
    if (action === "search") return { tool: "search_resources", arguments: args };
    if (action === "inspect") return { tool: "inspect_resource", arguments: { ...args, id: args.resource_id } };
    if (action === "apply") return { tool: "apply_resource", arguments: { ...args, id: args.resource_id } };
  }
  if (name === "initialize_prompt") return { tool: name, arguments: { ...args, positive_prompt: args.positive_prompt ?? args.positive, negative_prompt: args.negative_prompt ?? args.negative } };
  if (name === "edit_prompt") {
    const field = args.field === "negative" ? "negative" : "positive";
    const promptKey = field === "negative" ? "negative_prompt" : "positive_prompt";
    const hashKey = field === "negative" ? "negative_prompt_hash" : "positive_prompt_hash";
    return { tool: name, arguments: { ...args, field, prompt: args.prompt ?? args[promptKey], base_hash: args.base_hash ?? args[hashKey] ?? args.prompt_hash } };
  }
  return { tool: name, arguments: args };
}

export class LoomRuntimeController {
  readonly host: KohakuLoomHostApi;
  readonly client: KTClient;
  readonly actions: LoomActionHandlers;
  private activeRun: LoomRun | null = null;
  private readonly snapshots = new Map<string, unknown>();
  private mounted = false;
  private historyEventsAbort: AbortController | null = null;
  private historyEventsTask: Promise<void> | null = null;

  constructor(host: KohakuLoomHostApi, client = new KTClient({ baseUrl: host.ktBaseUrl })) {
    this.host = host;
    this.client = client;
    this.actions = {
      sendMessage: (input) => this.sendMessage(input),
      stopRequest: () => this.stopRequest(),
      attachFiles: () => undefined,
      replaceAttachment: () => undefined,
      removeAttachment: () => undefined,
      readPrompt: () => this.readPrompt(),
      clearChat: () => useChatStore.getState().reset(),
      copyMessage: async (message) => navigator.clipboard?.writeText(message.content),
      editResend: (message) => this.editResend(message),
      regenerate: (message) => this.regenerate(message),
      changeBranch: (message, branchIndex) => this.changeBranch(message, branchIndex),
      removeQueuedMessage: (id) => this.removeQueuedMessage(id),
      retryQueuedMessage: (id) => this.retryQueuedMessage(id),
      editQueuedMessage: (id, input) => this.editQueuedMessage(id, input),
      selectHistory: (row) => this.selectHistory(row),
      newSession: () => this.newSession(),
      openSettings: () => this.host.openSettings(),
      setRiskMode: (mode) => this.setRiskMode(mode),
    };
  }

  async mount(): Promise<void> {
    if (this.mounted) return;
    this.mounted = true;
    const runtime = useRuntimeStore.getState();
    runtime.setLoading(true);
    try {
      this.reloadProfiles();
      await this.syncProfiles();
      // Metadata is generated asynchronously after a turn or when an old
      // session is opened. Keep the archive in sync even while the chat is
      // idle; the run stream is only active during a turn.
      this.startHistoryEvents();
      await this.loadHistory();
    } catch (error) {
      runtime.setError(errorText(error));
    } finally {
      runtime.setLoading(false);
    }
  }

  destroy(): void {
    this.mounted = false;
    this.historyEventsAbort?.abort();
    this.historyEventsAbort = null;
    this.historyEventsTask = null;
  }

  reloadProfiles(): Profile[] {
    const state = asRecord(this.host.profileStore.load());
    const normalized = normalizeProfileState(state);
    useProfileStore.getState().setState(normalized);
    return normalized.profiles;
  }

  private async syncProfiles(): Promise<void> {
    await this.host.syncProfiles();
  }

  addProfile(profile: unknown): Profile {
    const result = mapProfile(this.host.profileStore.add(profile));
    this.reloadProfiles();
    return result;
  }

  duplicateProfile(id: string): Profile {
    const result = mapProfile(this.host.profileStore.duplicate(id));
    this.reloadProfiles();
    return result;
  }

  updateProfile(id: string, patch: unknown): Profile {
    const result = mapProfile(this.host.profileStore.update(id, patch));
    this.reloadProfiles();
    return result;
  }

  deleteProfile(id: string): Profile {
    const result = mapProfile(this.host.profileStore.delete(id));
    this.reloadProfiles();
    return result;
  }

  restoreProfiles(): Profile[] {
    this.host.profileStore.restoreDefaults();
    return this.reloadProfiles();
  }

  async loadHistory(query = ""): Promise<HistoryRow[]> {
    const [ktResult, legacyResult] = await Promise.allSettled([
      this.client.request<{ sessions?: unknown[] }>("/sessions"),
      this.host.listLegacySessions(50),
    ]);
    // The two archives are independent. A cold/unavailable KT sidecar must not
    // hide the legacy archive (and vice versa) from the history popover.
    if (ktResult.status === "rejected" && legacyResult.status === "rejected") {
      throw ktResult.reason ?? legacyResult.reason;
    }
    const rows = [
      ...(ktResult.status === "fulfilled" && Array.isArray(ktResult.value?.sessions)
        ? ktResult.value.sessions.map((item) => mapHistory(item, "KT"))
        : []),
      ...(legacyResult.status === "fulfilled" && Array.isArray(asRecord(legacyResult.value).sessions)
        ? asRecord(legacyResult.value).sessions.map((item: unknown) => mapHistory(item, "legacy"))
        : []),
    ];
    const normalized = query.trim().toLowerCase();
    const filtered = normalized ? rows.filter((row) => `${row.title} ${row.preview}`.toLowerCase().includes(normalized)) : rows;
    useRuntimeStore.getState().setHistory(filtered);
    return filtered;
  }

  private startHistoryEvents(): void {
    if (this.historyEventsTask) return;
    const controller = new AbortController();
    this.historyEventsAbort = controller;
    this.historyEventsTask = this.consumeHistoryEvents(controller.signal).finally(() => {
      if (this.historyEventsAbort === controller) this.historyEventsAbort = null;
      if (this.historyEventsTask) this.historyEventsTask = null;
    });
  }

  private async consumeHistoryEvents(signal: AbortSignal): Promise<void> {
    let cursor = 0;
    while (!signal.aborted) {
      try {
        for await (const event of this.client.stream("/turns/events", {
          signal,
          lastEventId: String(cursor),
        })) {
          const sequence = Number(event.sequence ?? event.id ?? 0);
          if (Number.isFinite(sequence)) cursor = Math.max(cursor, sequence);
          const data = asRecord(event.data);
          const type = String(data.type ?? event.event ?? "");
          if (type !== "session_metadata_updated") continue;
          // The event already contains the new metadata, but reloading the
          // archive also updates modified time and keeps legacy/KT merging in
          // one place.
          await this.loadHistory().catch(() => undefined);
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        // A transient sidecar restart should not disable live title updates.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1500);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    }
  }

  async openSession(sessionId = "", resume = Boolean(sessionId)): Promise<RuntimeSession> {
    if (this.activeRun && !this.activeRun.finished) throw new Error("Cannot switch sessions while a turn is active");
    await this.syncProfiles();
    const config = asRecord(this.host.assistantConfig());
    const current = useRuntimeStore.getState().sessionId;
    if (current) await this.client.request("/sessions/close", { method: "POST" });
    const response = await this.client.request<{ session: RuntimeSession }>("/sessions/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile_id: String(config.profile_id ?? useProfileStore.getState().activeProfileId ?? ""),
        session_id: sessionId,
        resume,
        forge_bridge: true,
        agent_mode: useUiStore.getState().riskMode,
      }),
    });
    const session = response.session;
    useRuntimeStore.getState().setSession(session);
    useUiStore.getState().setRiskMode(session.agent_mode === "yolo" ? "yolo" : "normal");
    useChatStore.getState().reset();
    await this.applySession(session.session_id);
    return session;
  }

  private async ensureSession(): Promise<string> {
    const existing = useRuntimeStore.getState().sessionId;
    if (existing) return existing;
    return (await this.openSession("", false)).session_id;
  }

  private async applySession(sessionId: string, runtime?: RawRecord): Promise<void> {
    const session = { ...asRecord(asRecord(runtime).active_session), session_id: sessionId } as RuntimeSession;
    useRuntimeStore.getState().setSession(session);
    useUiStore.getState().setRiskMode(session.agent_mode === "yolo" ? "yolo" : "normal");
    const conversation = await this.client.request<RawRecord>(`/sessions/${encodeURIComponent(sessionId)}`);
    this.applyConversation(conversation);
    const status = runtime ?? await this.client.request<RawRecord>("/runtime");
    if (status.active_turn_id) this.attachRuntime(status);
  }

  private attachRuntime(runtime: RawRecord): void {
    if (this.activeRun || !runtime.active_turn_id) return;
    const run = this.createRun(`restore-${String(runtime.active_turn_id)}`, runtime);
    this.activeRun = run;
    const signal = useChatStore.getState().beginRequest(run.requestId);
    this.syncWorking(run);
    signal.addEventListener("abort", () => run.controller.abort(), { once: true });
    if (run.text || run.reasoning) this.updateStreamingMessage(run);
    void (async () => {
      try {
        await this.startStreams(run);
        await run.done;
      } catch (error) {
        if (!run.cancelled) {
          if (run.assistantId) useChatStore.getState().updateMessage(run.assistantId, { status: "error" });
          useChatStore.getState().appendMessage({ id: `error-${run.requestId}`, role: "error", content: errorText(error), status: "error" });
        }
      } finally {
        if (!run.finished) this.finishRun(run, { status: run.cancelled ? "interrupted" : "error" });
        useChatStore.getState().finishRequest(run.requestId);
        this.clearWorking(run);
        if (this.activeRun === run) this.activeRun = null;
      }
    })();
  }

  private applyConversation(conversation: RawRecord): void {
    const branches = (conversation.branches ?? null) as BranchMetadata | null;
    useRuntimeStore.getState().setBranches(branches);
    const messages: ChatMessage[] = [];
    let turnIndex = 0;
    (Array.isArray(conversation.messages) ? conversation.messages : []).forEach((raw, index) => {
      const message = mapConversationMessage(raw, index, branches, turnIndex);
      if (message.role === "system") return;
      messages.push(message);
      if (message.role === "assistant") turnIndex += 1;
    });
    useChatStore.getState().setMessages(messages);
    this.syncQueue(Array.isArray(conversation.queue) ? conversation.queue : []);
  }

  private syncQueue(rawMessages: unknown[]): void {
    const activeStates = new Set(["pending", "guide_waiting", "running", "claimed", "failed"]);
    const queue = rawMessages.map(mapQueuedMessage).filter((item) => !item.state || activeStates.has(item.state));
    useChatStore.getState().setQueue(queue);
    useRuntimeStore.getState().setQueuePaused(Boolean(useRuntimeStore.getState().queuePaused));
  }

  private createRun(requestId: string, runtime?: RawRecord): LoomRun {
    let resolve!: (value: RawRecord) => void;
    const done = new Promise<RawRecord>((complete) => { resolve = complete; });
    const snapshot = asRecord(asRecord(runtime).active_turn);
    return {
      requestId,
      controller: new AbortController(),
      turnId: String(asRecord(runtime).active_turn_id ?? snapshot.turn_id ?? ""),
      turnCursor: Number(asRecord(runtime).turn_event_sequence) || 0,
      toolCursor: Number(asRecord(runtime).tool_event_sequence) || 0,
      bridgeId: "",
      text: String(snapshot.text ?? ""),
      reasoning: String(snapshot.reasoning ?? ""),
      usage: snapshot.usage,
      assistantId: null,
      cancelled: false,
      finished: false,
      leaseTimer: null,
      renderHandle: null,
      toolResults: new Map(),
      toolPromises: new Map(),
      activeTools: new Map(),
      pendingTurnEvents: [],
      resolve,
      done,
    };
  }

  private ensureStreamingMessage(run: LoomRun): string {
    if (run.assistantId) return run.assistantId;
    run.assistantId = `assistant-${run.requestId}`;
    useChatStore.getState().appendMessage({ id: run.assistantId, role: "assistant", content: run.text, reasoning: run.reasoning || undefined, status: "streaming" });
    return run.assistantId;
  }

  private updateStreamingMessage(run: LoomRun): void {
    if (run.cancelled) return;
    this.syncWorking(run);
    this.ensureStreamingMessage(run);
    if (run.renderHandle) return;
    if (typeof globalThis.requestAnimationFrame === "function") {
      run.renderHandle = { kind: "animation", id: globalThis.requestAnimationFrame(() => this.flushStreamingMessage(run)) };
      return;
    }
    run.renderHandle = { kind: "timeout", id: setTimeout(() => this.flushStreamingMessage(run), 16) };
  }

  private flushStreamingMessage(run: LoomRun): void {
    run.renderHandle = null;
    if (run.cancelled || run.finished) return;
    const id = this.ensureStreamingMessage(run);
    useChatStore.getState().updateMessage(id, { content: run.text, reasoning: run.reasoning || undefined, usage: usageFrom(run.usage), status: "streaming" });
  }

  private cancelStreamingRender(run: LoomRun): void {
    const handle = run.renderHandle;
    if (!handle) return;
    if (handle.kind === "animation") globalThis.cancelAnimationFrame?.(handle.id);
    else clearTimeout(handle.id);
    run.renderHandle = null;
  }

  private syncWorking(run: LoomRun): void {
    const activeRequestId = useChatStore.getState().activeRequestId;
    if (run.cancelled || run.finished || activeRequestId !== run.requestId) return;
    const tool = Array.from(run.activeTools.values()).at(-1);
    if (tool) {
      useRuntimeStore.getState().setWorking("tool", tool);
      return;
    }
    useRuntimeStore.getState().setWorking(run.text || run.reasoning ? "generating" : "thinking");
  }

  private clearWorking(run: LoomRun): void {
    const activeRequestId = useChatStore.getState().activeRequestId;
    if (!activeRequestId || activeRequestId === run.requestId) useRuntimeStore.getState().setWorking("idle");
  }

  private async startStreams(run: LoomRun): Promise<void> {
    const claim = await this.host.claimToolBridge();
    const claimRecord = asRecord(claim);
    if (claim === null || claim === undefined || claimRecord.owned === false) throw new Error("Forge tool bridge is unavailable or owned by another tab");
    run.bridgeId = String(claimRecord.bridge_id ?? "");
    run.leaseTimer = setInterval(() => { void this.host.claimToolBridge().then((next) => { run.bridgeId = String(asRecord(next).bridge_id ?? run.bridgeId); }).catch(() => undefined); }, 5000);
    void this.consumeStream("/turns/events", run, "turnCursor", (event) => this.handleTurnEvent(run, event));
    void this.consumeStream("/tools/events", run, "toolCursor", (event) => this.handleToolEvent(run, event));
    const pending = Array.isArray(claimRecord.pending_requests) ? claimRecord.pending_requests : [];
    for (const request of pending) await this.handleToolEvent(run, { type: "tool_request", payload: request });
  }

  private async consumeStream(path: string, run: LoomRun, cursor: "turnCursor" | "toolCursor", onEvent: (event: RawRecord) => Promise<void> | void): Promise<void> {
    try {
      for await (const event of this.client.stream(path, { signal: run.controller.signal, lastEventId: String(run[cursor]) })) {
        if (run.finished || run.cancelled) return;
        run[cursor] = Math.max(run[cursor], Number(event.sequence ?? 0));
        const data = asRecord(event.data);
        await onEvent(data.type ? data : { type: event.event, payload: data.payload ?? data });
      }
    } catch (error) {
      if (run.finished || run.cancelled || isAbortError(error)) return;
      if (path === "/tools/events") return;
      const runtime = await this.client.request<RawRecord>("/runtime").catch(() => null);
      const activeTurnId = String(asRecord(runtime).active_turn_id ?? "");
      if (runtime && activeTurnId && (!run.turnId || activeTurnId === run.turnId)) {
        const snapshot = asRecord(runtime.active_turn);
        run.turnId = activeTurnId;
        run.text = String(snapshot.text ?? run.text);
        run.reasoning = String(snapshot.reasoning ?? run.reasoning);
        run.usage = snapshot.usage ?? run.usage;
        if (run.text || run.reasoning) this.updateStreamingMessage(run);
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!run.finished && !run.cancelled) void this.consumeStream(path, run, cursor, onEvent);
        return;
      }
      const lastTurn = asRecord(asRecord(runtime).last_turn);
      if (runtime && run.turnId && String(lastTurn.turn_id ?? "") === run.turnId) {
        await this.handleTurnEvent(run, { type: "turn_ended", payload: lastTurn });
        return;
      }
      this.finishRun(run, { status: "error", error: errorText(error) });
    }
  }

  private async handleTurnEvent(run: LoomRun, event: RawRecord): Promise<void> {
    const type = String(event.type ?? event.event ?? "");
    const payload = asRecord(event.payload ?? event);
    if (!run.turnId && payload.turn_id) {
      run.pendingTurnEvents.push(event);
      return;
    }
    if (run.turnId && payload.turn_id && String(payload.turn_id) !== run.turnId) return;
    if (type === "text_delta") {
      run.text += String(payload.text ?? "");
      this.updateStreamingMessage(run);
    } else if (type === "reasoning_delta") {
      run.reasoning += String(payload.text ?? "");
      this.updateStreamingMessage(run);
    } else if (type === "reasoning_snapshot") {
      run.reasoning = String(payload.text ?? "");
      this.updateStreamingMessage(run);
    } else if (type === "usage") {
      run.usage = payload.usage ?? payload;
      if (run.assistantId) useChatStore.getState().updateMessage(run.assistantId, { usage: usageFrom(run.usage) });
    } else if (type === "message_queued" || type === "message_updated") {
      if (payload.message) this.syncQueue([...useChatStore.getState().queue, payload.message]);
    } else if (type === "queue_paused") {
      useRuntimeStore.getState().setQueuePaused(true);
    } else if (type === "queue_resumed") {
      useRuntimeStore.getState().setQueuePaused(false);
    } else if (type === "turn_ended") {
      if (run.cancelled) return;
      this.cancelStreamingRender(run);
      const finalText = String(payload.text ?? run.text);
      run.text = finalText;
      if (payload.reasoning) run.reasoning = String(payload.reasoning);
      if (payload.usage) run.usage = payload.usage;
      if (run.assistantId) {
        useChatStore.getState().updateMessage(run.assistantId, { content: finalText, reasoning: run.reasoning || undefined, usage: usageFrom(run.usage), status: ["ok", "completed"].includes(String(payload.status).toLowerCase()) ? "complete" : "error" });
      } else if (finalText) {
        run.assistantId = `assistant-${run.requestId}`;
        useChatStore.getState().appendMessage({ id: run.assistantId, role: "assistant", content: finalText, reasoning: run.reasoning || undefined, usage: usageFrom(run.usage), status: "complete" });
      }
      this.finishRun(run, payload);
    }
  }

  private async handleToolEvent(run: LoomRun, event: RawRecord): Promise<void> {
    if (String(event.type ?? event.event ?? "") !== "tool_request") return;
    const payload = asRecord(event.payload ?? event);
    const requestId = String(payload.request_id ?? "");
    if (!requestId) return;
    const existing = run.toolPromises.get(requestId);
    if (existing) return existing.then(() => undefined);
    const operation = (async () => {
      let result = run.toolResults.get(requestId);
      if (result === undefined) {
        const tool = adaptTool({ tool: payload.tool, arguments: payload.arguments });
        const name = String(tool.tool ?? "tool");
        const args = asRecord(tool.arguments);
        if (String(payload.agent_mode) === "yolo") args._yolo_authorized = true;
        run.activeTools.set(requestId, name);
        this.syncWorking(run);
        try {
          result = await this.host.executeTool({ ...tool, arguments: args }, run.controller.signal);
        } finally {
          run.activeTools.delete(requestId);
          this.syncWorking(run);
        }
        run.toolResults.set(requestId, result);
        const output = asRecord(result);
        const detail = output.ok === false ? String(output.error ?? "failed") : typeof result === "string" ? result : JSON.stringify(result);
        useChatStore.getState().upsertMessage({ id: `tool-${requestId}`, role: "tool", content: detail, status: output.ok === false ? "error" : "complete", tool: { name, status: output.ok === false ? "error" : "complete", detail } });
      }
      await this.client.request(`/tools/replies/${encodeURIComponent(requestId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bridge_id: run.bridgeId, ...asRecord(result) }),
        signal: run.controller.signal,
      });
      run.toolResults.delete(requestId);
    })();
    run.toolPromises.set(requestId, operation);
    try { await operation; } finally { run.toolPromises.delete(requestId); }
  }

  private finishRun(run: LoomRun, result: RawRecord): void {
    if (run.finished) return;
    this.cancelStreamingRender(run);
    run.finished = true;
    if (run.leaseTimer) clearInterval(run.leaseTimer);
    run.leaseTimer = null;
    run.resolve(result);
    run.controller.abort();
  }

  private async runTurn(input: SendMessageInput, run: LoomRun, sessionId: string): Promise<void> {
    try {
      const runtime = await this.client.request<RawRecord>("/runtime", { signal: run.controller.signal });
      run.turnCursor = Number(runtime.turn_event_sequence) || 0;
      run.toolCursor = Number(runtime.tool_event_sequence) || 0;
      await this.startStreams(run);
      const config = asRecord(this.host.assistantConfig());
      const accepted = await this.client.request<RawRecord>("/turns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: contentForMessage(input), timeout: config.timeout ?? asRecord(config.parameters).timeout ?? 120, operation_id: operationId("turn") }),
        signal: run.controller.signal,
      });
      run.turnId = String(accepted.turn_id ?? run.turnId);
      const pendingEvents = run.pendingTurnEvents.splice(0);
      for (const event of pendingEvents) await this.handleTurnEvent(run, event);
      await run.done;
    } catch (error) {
      if (run.cancelled || isAbortError(error)) return;
      if (run.assistantId) useChatStore.getState().updateMessage(run.assistantId, { status: "error" });
      throw error;
    } finally {
      if (!run.finished) this.finishRun(run, { status: run.cancelled ? "interrupted" : "error" });
      if (useRuntimeStore.getState().sessionId === sessionId) {
        const latest = await this.client.request<RawRecord>("/runtime").catch(() => null);
        if (latest) {
          useRuntimeStore.getState().setQueuePaused(Boolean(latest.queue_paused));
          this.syncQueue(Array.isArray(latest.messages) ? latest.messages : []);
        }
      }
    }
  }

  private async setRiskMode(mode: RiskMode): Promise<void> {
    const sessionId = useRuntimeStore.getState().sessionId;
    if (!sessionId) return;
    const result = await this.client.request<RawRecord>(`/sessions/${encodeURIComponent(sessionId)}/mode`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_mode: mode }),
    });
    const session = asRecord(result.session);
    useRuntimeStore.getState().setSession({ ...useRuntimeStore.getState().session, ...session, session_id: sessionId });
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    if (this.activeRun && !this.activeRun.finished) {
      const sessionId = await this.ensureSession();
      const content = contentForMessage(input);
      const response = await this.client.request<{ message: unknown }>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, display_content: input.text, attachments: input.attachments, operation_id: operationId("message") }),
      });
      useChatStore.getState().upsertQueue(mapQueuedMessage(response.message));
      return;
    }
    const sessionId = await this.ensureSession();
    const userId = `user-${operationId("message")}`;
    this.snapshots.set(userId, this.host.captureForgeState());
    useChatStore.getState().appendMessage({ id: userId, role: "user", content: input.text, attachments: input.attachments, status: "complete" });
    const run = this.createRun(userId);
    this.activeRun = run;
    const signal = useChatStore.getState().beginRequest(userId);
    this.syncWorking(run);
    signal.addEventListener("abort", () => run.controller.abort(), { once: true });
    try {
      await this.runTurn(input, run, sessionId);
    } catch (error) {
      if (!run.cancelled) {
        useChatStore.getState().appendMessage({ id: `error-${userId}`, role: "error", content: errorText(error), status: "error" });
      }
    } finally {
      useChatStore.getState().finishRequest(userId);
      this.clearWorking(run);
      if (this.activeRun === run) this.activeRun = null;
    }
  }

  stopRequest(): void {
    const run = this.activeRun;
    if (!run || run.finished) return;
    run.cancelled = true;
    useChatStore.getState().cancelRequest();
    this.finishRun(run, { status: "interrupted", cancelled: true });
    if (run.turnId) void this.client.request(`/turns/${encodeURIComponent(run.turnId)}/cancel`, { method: "POST" }).catch(() => undefined);
  }

  async readPrompt(): Promise<void> {
    const target = this.host.activePromptTarget();
    const result = await this.host.readPrompt(target);
    const detail = typeof result === "string" ? result : JSON.stringify(result);
    useChatStore.getState().appendMessage({ id: `tool-read-prompt-${Date.now()}`, role: "tool", content: detail, status: "complete", tool: { name: "read_prompt", status: "complete", detail } });
  }

  async editResend(message: ChatMessage): Promise<void> {
    const snapshot = this.snapshots.get(message.id);
    if (snapshot) this.host.restoreForgeState(snapshot);
    await this.sendMessage({ text: message.content, attachments: message.attachments, riskMode: "normal", reasoning: "low", editOf: message.id });
  }

  async removeQueuedMessage(id: string): Promise<void> {
    const sessionId = useRuntimeStore.getState().sessionId;
    if (!sessionId) return;
    const response = await this.client.request<{ message: unknown }>(`/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    const message = mapQueuedMessage(response.message);
    if (message.state && ["cancelled", "delivered"].includes(message.state)) useChatStore.getState().removeQueuedMessage(id);
    else useChatStore.getState().upsertQueue(message);
  }

  async retryQueuedMessage(id: string): Promise<void> {
    const sessionId = useRuntimeStore.getState().sessionId;
    if (!sessionId) return;
    const response = await this.client.request<{ message: unknown }>(`/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(id)}/retry`, { method: "POST" });
    useRuntimeStore.getState().setQueuePaused(false);
    useChatStore.getState().upsertQueue(mapQueuedMessage(response.message));
  }

  async editQueuedMessage(id: string, input: SendMessageInput): Promise<void> {
    const sessionId = useRuntimeStore.getState().sessionId;
    if (!sessionId) return;
    const response = await this.client.request<{ message: unknown }>(`/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: contentForMessage(input), display_content: input.text, attachments: input.attachments }),
    });
    useChatStore.getState().upsertQueue(mapQueuedMessage(response.message));
  }

  async selectHistory(row: HistoryRow): Promise<void> {
    if (row.source === "legacy") {
      const data = await this.host.getLegacySession(row.id);
      useRuntimeStore.getState().setLegacySession(row.id);
      const messages: ChatMessage[] = [];
      (Array.isArray(asRecord(data).events) ? asRecord(data).events : []).forEach((event: unknown, index: number) => {
        const value = asRecord(event);
        const message = asRecord(value.message ?? value.payload ?? value);
        const eventType = String(value.event_type ?? message.role ?? "");
        const attachments = message.image ? [{ id: `legacy-image-${index}`, name: String(message.filename ?? "reference image"), dataUrl: String(message.image) }] : [];
        if (eventType === "tool_result") {
          const result = asRecord(message.result);
          const failed = result.ok === false || Boolean(result.error);
          messages.push(chatMessageSchema.parse({
            id: `legacy-${index}`,
            role: "tool",
            content: "",
            status: failed ? "error" : "complete",
            tool: {
              name: String(message.tool ?? "Tool"),
              status: failed ? "error" : "complete",
              detail: failed ? "Tool failed in this archived session" : "Completed in this archived session",
            },
            attachments,
          }));
          return;
        }
        const content = textFromContent(message.content).trim();
        if (!content) return;
        const role = eventType.includes("user") ? "user" : eventType.includes("error") ? "error" : "assistant";
        messages.push(chatMessageSchema.parse({ id: `legacy-${index}`, role, content, status: role === "error" ? "error" : "complete", attachments }));
      });
      useChatStore.getState().setMessages(messages);
      useChatStore.getState().setQueue([]);
      return;
    }
    await this.openSession(row.id, true);
    // Opening a legacy KT session may queue its first metadata generation.
    // Refresh once immediately; the event listener above will pick up the
    // completed title without requiring a full page reload.
    await this.loadHistory().catch(() => undefined);
  }

  async newSession(): Promise<void> {
    if (this.activeRun && !this.activeRun.finished) throw new Error("Cannot create a new session while a turn is active");
    await this.client.request("/sessions/close", { method: "POST" });
    useRuntimeStore.getState().reset();
    useRuntimeStore.getState().setError(null);
    useChatStore.getState().reset();
    await this.openSession("", false);
  }

  async changeBranch(message: ChatMessage, branchIndex: number): Promise<void> {
    const sessionId = useRuntimeStore.getState().sessionId;
    const turnIndex = message.branchTurnIndex;
    const branches = useRuntimeStore.getState().branches;
    if (!sessionId || turnIndex === undefined || !branches?.turns) return;
    const turn = branches.turns.find((item) => item.turnIndex === turnIndex);
    const branchId = turn?.branches[branchIndex];
    if (branchId === undefined) return;
    const nextView = { ...(branches.branch_view ?? {}), [String(turnIndex)]: branchId };
    const response = await this.client.request<BranchMetadata>(`/sessions/${encodeURIComponent(sessionId)}/branch-view`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch_view: nextView }),
    });
    useRuntimeStore.getState().setBranches(response);
    const conversation = await this.client.request<RawRecord>(`/sessions/${encodeURIComponent(sessionId)}`);
    this.applyConversation(conversation);
  }

  async regenerate(_message: ChatMessage): Promise<void> {
    const sessionId = useRuntimeStore.getState().sessionId;
    if (!sessionId) return;
    const response = await this.client.request<BranchMetadata>(`/sessions/${encodeURIComponent(sessionId)}/regenerate`, { method: "POST" });
    useRuntimeStore.getState().setBranches(response);
    const conversation = await this.client.request<RawRecord>(`/sessions/${encodeURIComponent(sessionId)}`);
    this.applyConversation(conversation);
  }
}

export function createRuntimeController(namespace?: KohakuLoomNamespace): LoomRuntimeController | null {
  const host = getHostApi(namespace ?? (typeof window === "undefined" ? undefined : window.kohakuLoom));
  return host ? new LoomRuntimeController(host) : null;
}

export function requireRuntimeController(namespace?: KohakuLoomNamespace): LoomRuntimeController {
  const controller = createRuntimeController(namespace);
  if (!controller) throw new Error("Kohaku Loom Svelte UI requires a compatible host-provided versioned API");
  return controller;
}
