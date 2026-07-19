import type { LoomActionHandlers, ChatMessage, HistoryRow, Profile, SendMessageInput, BranchMetadata, RuntimeSession, MessageSubmission } from "./contracts";
import type { KohakuLoomHostApi } from "./bridge";
import { KTClient } from "./kt/client";
import { createAbortError, isAbortError } from "./kt/retry";
import { useChatStore } from "./stores/chat";
import { useProfileStore } from "./stores/profiles";
import { useRuntimeStore } from "./stores/runtime";
import { useUiStore } from "./stores/ui";
import { normalizeProfile, normalizeProfileState } from "./profile-adapter";
import { SessionTransition } from "./session-transition";
import { openSessionWithConflictRecovery } from "./runtime-session";
import { regenerateAssistantResponse } from "./runtime-regenerate";
import { mapLegacyMessages, parseBridgeLease, queuedMessageFromConversation, setBoundedMapValue } from "./runtime-state";
import {
  adaptTool,
  asRecord,
  contentForMessage,
  errorText,
  mapConversationMessage,
  mapHistory,
  mapQueuedMessage,
  normalizeBranchMetadata,
  operationId,
  providerRetryDetail,
  textFromContent,
  usageFrom,
} from "./runtime-formatters";

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
  cancelRequested: boolean;
  acceptanceTask: Promise<RawRecord> | null;
  accepted: boolean;
  acceptedResolve(value: MessageSubmission): void;
  acceptedReject(reason: unknown): void;
  acceptedSubmission: Promise<MessageSubmission>;
  resolve(value: RawRecord): void;
  done: Promise<RawRecord>;
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
  private readonly sessionTransition = new SessionTransition();
  private sessionEpoch = 0;
  private disposed = false;
  private readonly removingQueueIds = new Set<string>();
  private readonly regenerationOperations = new Map<string, string>();
  private readonly undoSnapshots = new Map<string, unknown>();
  private readonly undoOrder: string[] = [];

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
      regenerate: (message) => this.regenerate(message),
      changeBranch: (message, branchIndex) => this.changeBranch(message, branchIndex),
      removeQueuedMessage: (id) => this.removeQueuedMessage(id),
      retryQueuedMessage: (id) => this.retryQueuedMessage(id),
      editQueuedMessage: (id, input) => this.editQueuedMessage(id, input),
      selectHistory: (row) => this.selectHistory(row),
      newSession: () => this.newSession(),
      openSettings: () => this.host.openSettings(),
      undoToolMutation: (message) => this.undoToolMutation(message),
    };
  }

  async mount(): Promise<void> {
    if (this.mounted) return;
    this.mounted = true;
    const runtime = useRuntimeStore.getState();
    runtime.setLoading(true);
    runtime.setStartup("starting");
    runtime.setError(null);
    try {
      this.reloadProfiles();
      await this.syncProfiles();
      await this.loadHistory();
      // Keep async session metadata in sync while the chat is idle.
      this.startHistoryEvents();
      runtime.setStartup("ready");
    } catch (error) {
      runtime.setError(errorText(error));
      runtime.setStartup("error");
      this.mounted = false;
    } finally {
      runtime.setLoading(false);
    }
  }

  destroy(): void {
    this.sessionEpoch += 1;
    this.disposed = true;
    this.stopRequest();
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

  private async syncProfiles(): Promise<void> { await this.host.syncProfiles(); if ("profileStore" in this.host) this.reloadProfiles(); }

  addProfile(profile: unknown): Profile {
    const result = normalizeProfile(this.host.profileStore.add(profile));
    this.reloadProfiles();
    return result;
  }

  duplicateProfile(id: string): Profile {
    const result = normalizeProfile(this.host.profileStore.duplicate(id));
    this.reloadProfiles();
    return result;
  }

  updateProfile(id: string, patch: unknown): Profile {
    const result = normalizeProfile(this.host.profileStore.update(id, patch));
    this.reloadProfiles();
    return result;
  }

  deleteProfile(id: string): Profile {
    const result = normalizeProfile(this.host.profileStore.delete(id));
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
          if (type === "session_metadata_updated") {
            // The event already contains the new metadata, but reloading the
            // archive also updates modified time and keeps legacy/KT merging in
            // one place.
            await this.loadHistory().catch(() => undefined);
          } else {
            this.applyQueueEvent(data);
          }
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
    return this.sessionTransition.run(() => this.openSessionInternal(sessionId, resume));
  }
  private async openSessionInternal(sessionId = "", resume = Boolean(sessionId)): Promise<RuntimeSession> {
    if (this.activeRun && !this.activeRun.finished) throw new Error("Cannot switch sessions while a turn is active");
    const epoch = ++this.sessionEpoch;
    await this.syncProfiles();
    const runtime = await this.client.request<RawRecord>("/runtime").catch(() => null);
    const activeSession = asRecord(asRecord(runtime).active_session);
    const activeSessionId = String(activeSession.session_id ?? "");
    if (resume && sessionId && activeSessionId === sessionId) {
      await this.applySession(sessionId, runtime ?? undefined, epoch, activeSession);
      return { ...activeSession, session_id: sessionId } as RuntimeSession;
    }
    if (activeSessionId) await this.client.request("/sessions/close", { method: "POST" });
    const config = asRecord(this.host.assistantConfig());
    const opened = await openSessionWithConflictRecovery(this.client, {
      profile_id: String(config.profile_id ?? useProfileStore.getState().activeProfileId ?? ""), session_id: sessionId,
      resume, forge_bridge: true,
    });
    this.assertSessionCurrent(epoch);
    const session = opened.session;
    await this.applySession(session.session_id, opened.runtime, epoch, session);
    return session;
  }
  private async ensureSession(): Promise<string> {
    const existing = useRuntimeStore.getState().sessionId;
    if (existing) return existing;
    return this.sessionTransition.run(async () => {
      const current = useRuntimeStore.getState().sessionId;
      if (current) return current;
      const runtime = await this.client.request<RawRecord>("/runtime");
      const activeSessionId = String(asRecord(runtime.active_session).session_id ?? "");
      if (activeSessionId) {
        await this.applySession(activeSessionId, runtime);
        return activeSessionId;
      }
      return (await this.openSessionInternal("", false)).session_id;
    });
  }
  private assertSessionCurrent(epoch: number): void {
    if (epoch !== this.sessionEpoch || this.disposed) throw createAbortError();
  }

  private async applySession(sessionId: string, runtime?: RawRecord, epoch = this.sessionEpoch, seed: RawRecord = {}): Promise<void> {
    const conversation = await this.client.request<RawRecord>(`/sessions/${encodeURIComponent(sessionId)}`);
    const status = runtime ?? await this.client.request<RawRecord>("/runtime");
    this.assertSessionCurrent(epoch);
    const session = { ...asRecord(status.active_session), ...seed, session_id: sessionId } as RuntimeSession;
    useRuntimeStore.getState().setSession(session);
    this.applyConversation(conversation);
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
    const branches = normalizeBranchMetadata(conversation.branches ?? null);
    useRuntimeStore.getState().setBranches(branches);
    const messages: ChatMessage[] = [];
    const turnIndices = branches?.turns?.map((turn) => turn.turnIndex).sort((a, b) => a - b) ?? [];
    let userPosition = -1;
    let turnIndex = turnIndices[0] ?? 1;
    (Array.isArray(conversation.messages) ? conversation.messages : []).forEach((raw, index) => {
      const value = asRecord(raw);
      if (String(value.role ?? value.event_type ?? "").toLowerCase() === "user") {
        userPosition += 1;
        turnIndex = turnIndices[userPosition] ?? userPosition + 1;
      }
      const message = mapConversationMessage(raw, index, branches, turnIndex);
      if (message.role === "system") return;
      messages.push(message);
    });
    useChatStore.getState().setMessages(messages);
    this.syncQueue(Array.isArray(conversation.queue) ? conversation.queue : []);
  }

  private syncQueue(rawMessages: unknown[]): void {
    const activeStates = new Set(["pending", "guide_waiting", "running", "claimed", "failed"]);
    const queue = rawMessages
      .map(mapQueuedMessage)
      .filter((item) => !this.removingQueueIds.has(item.id) && (!item.state || activeStates.has(item.state)));
    useChatStore.getState().setQueue(queue);
  }

  private applyQueueMessage(rawMessage: unknown): void {
    const message = mapQueuedMessage(rawMessage);
    if (this.removingQueueIds.has(message.id)) return;
    if (message.state && ["cancelled", "delivered"].includes(message.state)) {
      useChatStore.getState().removeQueuedMessage(message.id);
      return;
    }
    useChatStore.getState().upsertQueue(message);
  }

  private applyQueueEvent(event: RawRecord): void {
    const type = String(event.type ?? event.event ?? "");
    const payload = asRecord(event.payload ?? event);
    if (type === "message_queued" || type === "message_updated") {
      if (payload.message) this.applyQueueMessage(payload.message);
    } else if (type === "queue_paused") {
      useRuntimeStore.getState().setQueuePaused(true);
    } else if (type === "queue_resumed") {
      useRuntimeStore.getState().setQueuePaused(false);
    }
  }

  private createRun(requestId: string, runtime?: RawRecord): LoomRun {
    let resolve!: (value: RawRecord) => void;
    const done = new Promise<RawRecord>((complete) => { resolve = complete; });
    let acceptedResolve!: (value: MessageSubmission) => void;
    let acceptedReject!: (reason: unknown) => void;
    const acceptedSubmission = new Promise<MessageSubmission>((complete, reject) => {
      acceptedResolve = complete;
      acceptedReject = reject;
    });
    void acceptedSubmission.catch(() => undefined);
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
      cancelRequested: false,
      acceptanceTask: null,
      accepted: Boolean(asRecord(runtime).active_turn_id ?? snapshot.turn_id),
      acceptedResolve,
      acceptedReject,
      acceptedSubmission,
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
    if (run.cancelRequested) {
      useRuntimeStore.getState().setWorking("cancelling");
      return;
    }
    if (!run.accepted) {
      useRuntimeStore.getState().setWorking("submitting");
      return;
    }
    useRuntimeStore.getState().setWorking(run.text || run.reasoning ? "generating" : "thinking");
  }

  private clearWorking(run: LoomRun): void {
    const activeRequestId = useChatStore.getState().activeRequestId;
    if (!activeRequestId || activeRequestId === run.requestId) useRuntimeStore.getState().setWorking("idle");
  }

  private startStreams(run: LoomRun): void {
    void this.consumeStream("/turns/events", run, "turnCursor", (event) => this.handleTurnEvent(run, event));
    void this.startToolStream(run);
  }

  private async startToolStream(run: LoomRun): Promise<void> {
    let claim;
    try {
      claim = parseBridgeLease(await this.host.claimToolBridge());
    } catch {
      this.loseBridgeLease(run, "Forge tool bridge could not be claimed");
      return;
    }
    if (!claim) {
      this.loseBridgeLease(run, "Forge tool bridge returned an invalid lease");
      return;
    }
    if (!claim.owned) {
      this.loseBridgeLease(run, "Forge tool bridge is unavailable or owned by another tab");
      return;
    }
    if (this.disposed || run.finished || run.cancelled || run.controller.signal.aborted) {
      if (this.host.releaseToolBridge) await this.host.releaseToolBridge().catch(() => undefined);
      return;
    }
    run.bridgeId = claim.bridgeId;
    run.leaseTimer = setInterval(() => { void this.refreshBridgeLease(run); }, 5000);
    void this.consumeStream("/tools/events", run, "toolCursor", (event) => this.handleToolEvent(run, event));
    for (const request of claim.pendingRequests) {
      if (run.finished || run.cancelled) return;
      await this.handleToolEvent(run, { type: "tool_request", payload: request });
    }
  }

  private async consumeStream(path: string, run: LoomRun, cursor: "turnCursor" | "toolCursor", onEvent: (event: RawRecord) => Promise<void> | void): Promise<void> {
    try {
      for await (const event of this.client.stream(path, { signal: run.controller.signal, lastEventId: String(run[cursor]) })) {
        if (this.disposed || run.finished || run.cancelled) return;
        const sequence = Number(event.sequence ?? 0);
        if (Number.isFinite(sequence)) run[cursor] = Math.max(run[cursor], sequence);
      const data = asRecord(event.data);
      await onEvent(data.type ? data : { type: event.event, payload: data.payload ?? data });
      }
      if (!run.finished && !run.cancelled) throw new Error(`${path} ended before its terminal event`);
    } catch (error) {
      if (run.finished || run.cancelled || isAbortError(error)) return;
      if (path === "/tools/events") {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!run.finished && !run.cancelled) void this.consumeStream(path, run, cursor, onEvent);
        return;
      }
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
    if (this.disposed || run.finished || run.cancelled) return;
    const type = String(event.type ?? event.event ?? "");
    const payload = asRecord(event.payload ?? event);
    if (!run.turnId && payload.turn_id) {
      run.pendingTurnEvents.push(event);
      return;
    }
    if (run.turnId && payload.turn_id && String(payload.turn_id) !== run.turnId) return;
    if (type === "turn_started") {
      run.accepted = true;
      this.syncWorking(run);
    } else if (type === "provider_retry") {
      useRuntimeStore.getState().setWorking("retrying", providerRetryDetail(payload));
    } else if (type === "text_delta") {
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
    } else if (["message_queued", "message_updated", "queue_paused", "queue_resumed"].includes(type)) {
      this.applyQueueEvent(event);
    } else if (type === "turn_ended") {
      if (run.cancelled) return;
      this.cancelStreamingRender(run);
      const finalText = String(payload.text ?? run.text);
      run.text = finalText;
      if (payload.reasoning) run.reasoning = String(payload.reasoning);
      if (payload.usage) run.usage = payload.usage;
      const terminalStatus = String(payload.status).toLowerCase();
      const interrupted = run.cancelRequested || ["interrupted", "cancelled", "canceled"].includes(terminalStatus);
      const succeeded = ["ok", "completed"].includes(terminalStatus);
      if (run.assistantId) {
        useChatStore.getState().updateMessage(run.assistantId, { content: finalText, reasoning: run.reasoning || undefined, usage: usageFrom(run.usage), status: interrupted ? "cancelled" : succeeded ? "complete" : "error" });
      } else if (finalText) {
        run.assistantId = `assistant-${run.requestId}`;
        useChatStore.getState().appendMessage({ id: run.assistantId, role: "assistant", content: finalText, reasoning: run.reasoning || undefined, usage: usageFrom(run.usage), status: interrupted ? "cancelled" : succeeded ? "complete" : "error" });
      } else if (!interrupted && !succeeded) {
        useChatStore.getState().appendMessage({ id: `error-${run.requestId}`, role: "error", content: errorText(payload.error ?? "Provider request failed without returning a response."), status: "error" });
      }
      this.finishRun(run, payload);
    }
  }

  private async handleToolEvent(run: LoomRun, event: RawRecord): Promise<void> {
    if (this.disposed || run.finished || run.cancelled) return;
    if (typeof this.host.claimToolBridge === "function" && !(await this.refreshBridgeLease(run))) return;
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
        run.activeTools.set(requestId, name);
        this.syncWorking(run);
        const toolMessageId = `tool-${requestId}`;
        const snapshot = this.isForgeMutation(name, args) ? this.host.captureForgeState() : undefined;
        try {
          result = await this.host.executeTool({ ...tool, arguments: args }, run.controller.signal);
        } finally {
          run.activeTools.delete(requestId);
          this.syncWorking(run);
        }
        run.toolResults.set(requestId, result);
        const output = asRecord(result);
        const detail = output.ok === false ? String(output.error ?? "failed") : typeof result === "string" ? result : JSON.stringify(result);
        const succeeded = output.ok !== false;
        if (succeeded && snapshot !== undefined) this.rememberUndoSnapshot(toolMessageId, snapshot);
        useChatStore.getState().upsertMessage({ id: toolMessageId, role: "tool", content: detail, status: succeeded ? "complete" : "error", tool: { name, status: succeeded ? "complete" : "error", detail, undoable: succeeded && snapshot !== undefined } });
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
    const release = this.host.releaseToolBridge;
    if (release) void Promise.resolve(release.call(this.host)).catch(() => undefined);
  }

  private isForgeMutation(name: string, args: RawRecord): boolean {
    return name === "edit_prompt"
      || name === "initialize_prompt"
      || name === "patch_current_prompt"
      || name === "multi_patch_current_prompt"
      || (name === "apply_resource" && String(args.action ?? "apply") === "apply")
      || (name === "forge_resource" && String(args.action ?? "") === "apply");
  }

  private rememberUndoSnapshot(messageId: string, snapshot: unknown): void {
    const previous = this.undoOrder.at(-1);
    if (previous) {
      const message = useChatStore.getState().messages.find((item) => item.id === previous);
      if (message?.tool) useChatStore.getState().updateMessage(previous, { tool: { ...message.tool, undoable: false } });
    }
    this.undoSnapshots.set(messageId, snapshot);
    this.undoOrder.push(messageId);
    while (this.undoOrder.length > 32) {
      const removed = this.undoOrder.shift();
      if (removed) this.undoSnapshots.delete(removed);
    }
  }

  private loseBridgeLease(run: LoomRun, message: string): false {
    const turnId = run.turnId;
    run.cancelled = true;
    run.cancelRequested = true;
    useRuntimeStore.getState().setError(message);
    if (!run.accepted) run.acceptedReject(new Error(message));
    this.finishRun(run, { status: "error", error: message });
    if (turnId) void this.cancelAcceptedTurn(run, turnId);
    return false;
  }

  private async refreshBridgeLease(run: LoomRun): Promise<boolean> {
    if (this.disposed || run.finished || run.cancelled) return false;
    if (typeof this.host.claimToolBridge !== "function") return true;
    try {
      const next = parseBridgeLease(await this.host.claimToolBridge());
      if (!next) return this.loseBridgeLease(run, "Forge tool bridge returned an invalid lease");
      if (!next.owned) return this.loseBridgeLease(run, "Forge tool bridge was taken by another tab");
      run.bridgeId = next.bridgeId;
      return true;
    } catch {
      return this.loseBridgeLease(run, "Forge tool bridge could not be renewed");
    }
  }

  private async runTurn(input: SendMessageInput, run: LoomRun, sessionId: string): Promise<void> {
    try {
      const runtime = await this.client.request<RawRecord>("/runtime", { signal: run.controller.signal });
      run.turnCursor = Number(runtime.turn_event_sequence) || 0;
      run.toolCursor = Number(runtime.tool_event_sequence) || 0;
      this.startStreams(run);
      if (run.cancelled || run.finished || run.controller.signal.aborted) return;
      const config = asRecord(this.host.assistantConfig());
      const acceptedTask = this.client.request<RawRecord>("/turns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: run.controller.signal,
        body: JSON.stringify({ content: contentForMessage(input), timeout: config.timeout ?? asRecord(config.parameters).timeout ?? 120, operation_id: operationId("turn") }),
      });
      run.acceptanceTask = acceptedTask;
      void acceptedTask.then((late) => {
        const lateTurnId = String(late.turn_id ?? "");
        if (run.cancelRequested && lateTurnId) void this.cancelAcceptedTurn(run, lateTurnId);
      }).catch(() => undefined);
      const aborted = new Promise<RawRecord>((_, reject) => {
        const abort = () => reject(createAbortError());
        if (run.controller.signal.aborted) abort();
        else run.controller.signal.addEventListener("abort", abort, { once: true });
      });
      const accepted = await Promise.race([acceptedTask, aborted]);
      run.turnId = String(accepted.turn_id ?? run.turnId);
      if (!run.turnId) throw new Error("Kohaku Loom did not return a turn id");
      run.accepted = true;
      useChatStore.getState().appendMessage({ id: run.requestId, role: "user", content: input.text, attachments: input.displayAttachments ?? input.attachments, status: "complete" });
      run.acceptedResolve({ kind: "turn", id: run.turnId });
      this.syncWorking(run);
      const pendingEvents = run.pendingTurnEvents.splice(0);
      for (const event of pendingEvents) await this.handleTurnEvent(run, event);
      await run.done;
    } catch (error) {
      if (!run.accepted) run.acceptedReject(error);
      if (run.cancelled || isAbortError(error)) return;
      if (run.assistantId) useChatStore.getState().updateMessage(run.assistantId, { status: "error" });
      throw error;
    } finally {
      if (!run.accepted && (run.cancelled || run.finished || run.controller.signal.aborted)) run.acceptedReject(createAbortError());
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

  async sendMessage(input: SendMessageInput): Promise<MessageSubmission> {
    if (input.editOf) {
      await this.editAndRerun(input);
      return { kind: "edit", id: input.editOf };
    }
    const sessionId = await this.ensureSession();
    if (this.activeRun && !this.activeRun.finished) {
      const content = contentForMessage(input);
      const response = await this.client.request<{ message: unknown }>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, display_content: input.text, operation_id: operationId("message") }),
      });
      const message = mapQueuedMessage(response.message);
      this.applyQueueMessage(message);
      return { kind: "queued", id: message.id };
    }
    const userId = `user-${operationId("message")}`;
    setBoundedMapValue(this.snapshots, userId, this.host.captureForgeState(), 32);
    const run = this.createRun(userId);
    this.activeRun = run;
    const signal = useChatStore.getState().beginRequest(userId);
    this.syncWorking(run);
    signal.addEventListener("abort", () => run.controller.abort(), { once: true });
    void this.runTurn(input, run, sessionId)
      .catch((error) => {
        if (!run.accepted) run.acceptedReject(error);
        if (!run.cancelled) useChatStore.getState().appendMessage({ id: `error-${userId}`, role: "error", content: errorText(error), status: "error" });
      })
      .finally(() => {
        useChatStore.getState().finishRequest(userId);
        this.clearWorking(run);
        if (this.activeRun === run) this.activeRun = null;
      });
    return run.acceptedSubmission;
  }

  stopRequest(): void {
    const run = this.activeRun;
    if (!run || run.finished) return;
    run.cancelRequested = true;
    this.syncWorking(run);
    if (run.turnId) {
      void this.cancelAcceptedTurn(run, run.turnId);
      return;
    }
    run.cancelled = true;
    useChatStore.getState().cancelRequest();
    this.finishRun(run, { status: "interrupted", cancelled: true });
  }

  private async cancelAcceptedTurn(run: LoomRun, turnId: string): Promise<void> {
    run.turnId = turnId;
    try {
      await this.client.request(`/turns/${encodeURIComponent(turnId)}/cancel`, { method: "POST" });
    } catch (error) {
      const runtime = await this.client.request<RawRecord>("/runtime").catch(() => null);
      const activeTurnId = String(asRecord(runtime).active_turn_id ?? "");
      const lastTurn = asRecord(asRecord(runtime).last_turn);
      if (activeTurnId === turnId) {
        run.cancelRequested = false;
        useRuntimeStore.getState().setError(errorText(error));
        this.syncWorking(run);
        return;
      }
      if (String(lastTurn.turn_id ?? "") === turnId) {
        await this.handleTurnEvent(run, { type: "turn_ended", payload: lastTurn });
        return;
      }
      run.cancelled = true;
      useChatStore.getState().cancelRequest();
      this.finishRun(run, { status: "interrupted", cancelled: true });
    }
  }

  async readPrompt(): Promise<void> {
    const target = this.host.activePromptTarget();
    const result = await this.host.readPrompt(target);
    const detail = typeof result === "string" ? result : JSON.stringify(result);
    useChatStore.getState().appendMessage({ id: `tool-read-prompt-${Date.now()}`, role: "tool", content: detail, status: "complete", tool: { name: "read_prompt", status: "complete", detail } });
  }

  async undoToolMutation(message: ChatMessage): Promise<void> {
    const snapshot = this.undoSnapshots.get(message.id);
    if (!snapshot || this.undoOrder.at(-1) !== message.id || message.role !== "tool" || !message.tool?.undoable || message.tool.undone) {
      throw new Error("This prompt change is no longer available to undo");
    }
    if (!this.host.restoreForgeState(snapshot)) throw new Error("Forge could not restore the saved prompt state");
    this.undoSnapshots.delete(message.id);
    this.undoOrder.pop();
    useChatStore.getState().updateMessage(message.id, { tool: { ...message.tool, undoable: false, undone: true } });
    const previous = this.undoOrder.at(-1);
    if (previous) {
      const previousMessage = useChatStore.getState().messages.find((item) => item.id === previous);
      if (previousMessage?.tool) useChatStore.getState().updateMessage(previous, { tool: { ...previousMessage.tool, undoable: true } });
    }
  }

  private async editAndRerun(input: SendMessageInput): Promise<void> {
    if (this.activeRun && !this.activeRun.finished) throw new Error("Wait for the active response before editing a message");
    const sessionId = useRuntimeStore.getState().sessionId;
    const messages = useChatStore.getState().messages;
    const target = messages.find((message) => message.id === input.editOf);
    if (!sessionId || !target || target.role !== "user") {
      throw new Error("The message is no longer available to edit");
    }
    const userPosition = messages.filter((message) => message.role === "user").findIndex((message) => message.id === target.id);
    if (userPosition < 0) throw new Error("The message is no longer available to edit");
    const turnIndex = target.branchTurnIndex ?? userPosition + 1;
    const snapshot = this.snapshots.get(target.id);
    if (snapshot) this.host.restoreForgeState(snapshot);
    const response = await this.client.request<BranchMetadata>(`/sessions/${encodeURIComponent(sessionId)}/edit-rerun`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: contentForMessage(input), turn_index: turnIndex, user_position: userPosition, operation_id: operationId("edit-rerun") }),
    });
    useRuntimeStore.getState().setBranches(normalizeBranchMetadata(response));
    const conversation = await this.client.request<RawRecord>(`/sessions/${encodeURIComponent(sessionId)}`);
    this.applyConversation(conversation);
  }

  async removeQueuedMessage(id: string): Promise<void> {
    const sessionId = useRuntimeStore.getState().sessionId;
    if (!sessionId) return;
    const previous = useChatStore.getState().queue.find((message) => message.id === id);
    if (!previous || this.removingQueueIds.has(id)) return;
    this.removingQueueIds.add(id);
    useChatStore.getState().removeQueuedMessage(id);
    try {
      const response = await this.client.request<{ message: unknown }>(`/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      const message = mapQueuedMessage(response.message);
      if (!message.state || !["cancelled", "delivered"].includes(message.state)) {
        this.removingQueueIds.delete(id);
        this.applyQueueMessage(message);
      }
    } catch (error) {
      const conversation = await this.client.request<RawRecord>(`/sessions/${encodeURIComponent(sessionId)}`).catch(() => null);
      const authoritative = queuedMessageFromConversation(conversation, id);
      this.removingQueueIds.delete(id);
      if (authoritative && (!authoritative.state || !["cancelled", "delivered"].includes(authoritative.state))) {
        this.applyQueueMessage(authoritative);
      } else if (!conversation) {
        useChatStore.getState().upsertQueue(previous);
        throw error;
      }
    } finally {
      this.removingQueueIds.delete(id);
    }
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
      body: JSON.stringify({ content: contentForMessage(input), display_content: input.text }),
    });
    useChatStore.getState().upsertQueue(mapQueuedMessage(response.message));
  }

  async selectHistory(row: HistoryRow): Promise<void> {
    if (row.source === "legacy") {
      const data = await this.host.getLegacySession(row.id);
      useRuntimeStore.getState().setLegacySession(row.id);
      useChatStore.getState().setMessages(mapLegacyMessages(data));
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
    this.sessionEpoch += 1;
    await this.sessionTransition.run(async () => {
      if (this.activeRun && !this.activeRun.finished) throw new Error("Cannot create a new session while a turn is active");
      useRuntimeStore.getState().reset();
      useRuntimeStore.getState().setError(null);
      useChatStore.getState().reset();
      await this.openSessionInternal("", false);
    });
  }

  async changeBranch(message: ChatMessage, branchIndex: number): Promise<void> {
    const sessionId = useRuntimeStore.getState().sessionId;
    const turnIndex = message.branchTurnIndex;
    const branches = useRuntimeStore.getState().branches;
    if (!sessionId || turnIndex === undefined || !branches?.turns) return;
    const turn = branches.turns.find((item) => item.turnIndex === turnIndex);
    const selected = turn?.selectedBranchId ?? turn?.latestBranch;
    const selectedGroup = turn?.userGroups?.find((group) => group.branches.includes(selected ?? -1));
    const branchId = message.role === "user"
      ? turn?.userGroups?.[branchIndex]?.branches.at(-1)
      : (selectedGroup?.branches ?? turn?.branches ?? [])[branchIndex];
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

  async regenerate(message: ChatMessage): Promise<void> {
    const sessionId = useRuntimeStore.getState().sessionId;
    if (!sessionId) throw new Error("Open a Loom session before regenerating a response");
    const key = `${sessionId}:${message.id}`;
    const requestId = this.regenerationOperations.get(key) ?? `regenerate-${message.id}-${operationId("branch")}`;
    setBoundedMapValue(this.regenerationOperations, key, requestId, 32);
    await regenerateAssistantResponse(this.client, sessionId, message, requestId, (conversation) => this.applyConversation(conversation));
    this.regenerationOperations.delete(key);
  }
}
