<script lang="ts">
  import { onMount } from "svelte";
  import {
    AlertTriangle, Bot, Check, ChevronLeft, ChevronRight,
    CircleStop, Clipboard, Clock3, Copy, FileArchive, FileCog, Grip, History,
    ImagePlus, Pencil, Plus, RefreshCw, Search, Send, Settings2,
    ShieldAlert, ShieldCheck, Sparkles, SquarePen, Trash2, UserRound, Wrench, X,
    XCircle,
  } from "lucide-svelte";
  import type {
    ChatAttachment, ChatMessage, HistoryRow, LoomActionHandlers, MessageSubmission,
    ReasoningEffort, SendMessageInput,
  } from "../contracts";
  import {
    attachmentPreviewUrl,
    assertAttachmentTotal,
    createImageAttachment,
    displayImageAttachment,
    materializeImageAttachments,
    MAX_ATTACHMENTS,
    releaseImageAttachment,
    releaseImageAttachments,
    retainImageAttachments,
    type PreparedImageAttachment,
  } from "../attachments";
  import { noopActions } from "../mock-data";
  import type { LoomRuntimeController } from "../runtime-controller";
  import { connectRuntimeController } from "../runtime-connection";
  import { errorText } from "../runtime-formatters";
  import { AlertDialog } from "$lib/components/ui/alert-dialog";
  import { useChatStore } from "../stores/chat";
  import { useI18nStore } from "../stores/i18n";
  import { useProfileStore } from "../stores/profiles";
  import { useRuntimeStore } from "../stores/runtime";
  import { useUiStore } from "../stores/ui";
  import { clampWindowLayout, minimumForViewport, pointerPosition, pointerWindow, readViewportRect, resolveViewportAfterKeyboard, viewportKind, type FloatingPosition, type LayoutViewport } from "../window-interactions";
  import Markdown from "./Markdown.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import ProfileSettings from "./ProfileSettings.svelte";
  import ReasoningPicker from "./ReasoningPicker.svelte";
  import WorkingIndicator from "./WorkingIndicator.svelte";

  interface Props {
    messages?: ChatMessage[];
    history?: HistoryRow[];
    actions?: Partial<LoomActionHandlers>;
    initialAttachments?: ChatAttachment[];
    initialOpen?: boolean;
  }

  let {
    messages: providedMessages,
    history: providedHistory,
    actions: actionOverrides = {},
    initialAttachments = [],
    initialOpen = false,
  }: Props = $props();

  let draft = $state("");
  let attachments = $state<PreparedImageAttachment[]>([]);
  let reasoning = $state<ReasoningEffort>("low");
  let historySearch = $state("");
  let lightbox = $state<{ attachments: PreparedImageAttachment[]; index: number } | null>(null);
  let copiedId = $state<string | null>(null);
  let collapsedMessageIds = $state<Set<string>>(new Set());
  let dropActive = $state(false);
  let interacting = $state(false);
  let launcherInteracting = $state(false);
  let launcherDragged = $state(false);
  let mobileHintDismissed = $state(false);
  let stableViewport = readViewportRect();
  let viewportRecovering = false;
  let kind = $state<LayoutViewport>(viewportKind(stableViewport));
  let viewport = $state(stableViewport);
  let fileInput = $state<HTMLInputElement>();
  let composerInput = $state<HTMLTextAreaElement>();
  let replacementInput = $state<HTMLInputElement>();
  let replacementId = $state<string | null>(null);
  let attachmentMenuId = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let editingMessageId = $state<string | null>(null);
  let preEditDraft = $state<{ text: string; attachments: PreparedImageAttachment[] } | null>(null);
  let confirm = $state<"yolo" | null>(null);
  let returnToChatAfterSettings = $state(false);
  let controller = $state<LoomRuntimeController | null>(null);
  let controllerReady: Promise<LoomRuntimeController> | null = null;
  let controllerAbort: AbortController | null = null;
  let connectionState = $state<"idle" | "connecting" | "ready" | "failed">("idle");
  let connectionError = $state<string | null>(null);
  let sessionTransition: Promise<void> | null = null;

  const visibleMessages = $derived(providedMessages ?? $useChatStore.messages);
  const runtimeUnavailable = $derived(connectionState === "failed" && !Object.keys(actionOverrides).length);
  const visibleHistory = $derived(providedHistory ?? (controller ? $useRuntimeStore.history : []));
  const filteredHistory = $derived(visibleHistory.filter((row) => {
    const query = historySearch.trim().toLowerCase();
    return !query || `${row.title} ${row.preview}`.toLowerCase().includes(query);
  }));
  const windowMinimum = $derived(minimumForViewport(kind));
  const currentLayout = $derived(clampWindowLayout($useUiStore.layouts[kind], viewport, windowMinimum));
  const activeProfile = $derived($useProfileStore.profiles.find((profile) => profile.id === $useProfileStore.activeProfileId && profile.enabled));
  const lastAssistantId = $derived([...visibleMessages].reverse().find((message) => message.role === "assistant")?.id);
  const workingPhase = $derived($useRuntimeStore.workingPhase);
  const workingReasoning = $derived([...visibleMessages].reverse().find((message) => message.role === "assistant" && message.status === "streaming" && message.reasoning)?.reasoning ?? "");
  const pendingToolApproval = $derived($useRuntimeStore.pendingToolApproval);
  const runtimeStarting = $derived($useRuntimeStore.startup === "starting");

  function t(key: string, fallback: string): string {
    const value = $useI18nStore.t(key);
    return value === key ? fallback : value;
  }

  function tf(key: string, fallback: string, values: Record<string, string | number>): string {
    return Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      t(key, fallback),
    );
  }

  function roleLabel(message: ChatMessage): string {
    if (message.role === "tool") return message.tool?.name ?? t("chat.role.tool", "Tool");
    return t(`chat.role.${message.role}`, message.role);
  }

  function reasoningPreview(value: string): string {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
  }

  function toggleMessage(messageId: string): void {
    const next = new Set(collapsedMessageIds);
    if (next.has(messageId)) next.delete(messageId); else next.add(messageId);
    collapsedMessageIds = next;
  }

  function runtimeErrorText(value: string): string {
    if (/KT HTTP request failed|HTTP 503|sidecar.*(starting|unavailable)|still starting/i.test(value)) {
      return t("assistant.runtime.retry", "The Loom runtime is starting or unavailable. Open chat history to retry, or check the sidecar configuration in Model profiles.");
    }
    return value;
  }

  function syncReasoningFromProfile(): void {
    const profileValue = String(activeProfile?.parameters.reasoningEffort ?? "low").toLowerCase();
    reasoning = ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(profileValue)
      ? profileValue as ReasoningEffort
      : "none";
  }

  function id(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function updateLayout(next: typeof currentLayout): void {
    $useUiStore.setLayout(kind, next);
    if (kind !== "desktop") $useUiStore.markMobileResizeHintSeen();
  }

  function updateLauncherPosition(next: FloatingPosition): void {
    $useUiStore.setLauncherPosition(next);
  }

  function openLauncher(): void {
    if (launcherDragged) {
      launcherDragged = false;
      return;
    }
    $useUiStore.setShellOpen(true);
    $useUiStore.bringToFront("chat");
    void ensureControllerReady().catch(() => undefined);
    requestAnimationFrame(() => composerInput?.focus());
  }

  function isTextEntryFocused(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement
      || active instanceof HTMLSelectElement
      || (active instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit"].includes(active.type));
  }

  function refreshViewport(): void {
    const focused = isTextEntryFocused();
    const next = resolveViewportAfterKeyboard(stableViewport, readViewportRect(), focused, viewportRecovering);
    stableViewport = next.stable;
    viewportRecovering = next.recovering;
    viewport = next.viewport;
    if (!focused) kind = viewportKind(viewport);
  }

  async function ensureControllerReady(): Promise<LoomRuntimeController | null> {
    if (Object.keys(actionOverrides).length) return null;
    if (controller) return controller;
    if (controllerReady) return controllerReady;
    connectionState = "connecting";
    connectionError = null;
    const abort = new AbortController();
    controllerAbort = abort;
    const pending = connectRuntimeController(() => window.kohakuLoom, abort.signal)
      .then(async (next) => {
        if (abort.signal.aborted) {
          next.destroy();
          throw new DOMException("Aborted", "AbortError");
        }
        controller = next;
        await next.mount();
        if (abort.signal.aborted) {
          next.destroy();
          controller = null;
          throw new DOMException("Aborted", "AbortError");
        }
        connectionState = "ready";
        return next;
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          connectionState = "failed";
          connectionError = error instanceof Error ? error.message : String(error);
        }
        throw error;
      })
      .finally(() => {
        if (controllerReady === pending) controllerReady = null;
      });
    controllerReady = pending;
    return pending;
  }

  function action<K extends keyof LoomActionHandlers>(name: K): LoomActionHandlers[K] {
    const resolved = actionOverrides[name] ?? controller?.actions[name];
    if (resolved) return resolved as LoomActionHandlers[K];
    if (Object.keys(actionOverrides).length || ["attachFiles", "replaceAttachment", "removeAttachment", "copyMessage", "clearChat"].includes(name)) {
      return noopActions[name] as LoomActionHandlers[K];
    }
    return (() => {
      notice = connectionError ?? "Kohaku Loom is still connecting to the Forge runtime.";
      void ensureControllerReady().catch(() => undefined);
    }) as LoomActionHandlers[K];
  }

  async function send(input: SendMessageInput): Promise<MessageSubmission | void> {
    if (actionOverrides.sendMessage) {
      return await actionOverrides.sendMessage(input);
    }
    const activeController = await ensureControllerReady();
    if (!activeController) throw new Error("Kohaku Loom runtime controller is unavailable");
    return await activeController.actions.sendMessage(input);
  }

  async function submit(): Promise<void> {
    if (!draft.trim() && !attachments.length) return;
    notice = null;
    const submittedDraft = draft;
    const submittedAttachments = [...attachments];
    draft = "";
    attachments = [];
    requestAnimationFrame(() => resizeComposer());
    try {
      await sessionTransition;
      const input = {
        text: submittedDraft.trim(),
        attachments: await materializeImageAttachments(submittedAttachments),
        displayAttachments: submittedAttachments.map(displayImageAttachment),
        riskMode: $useUiStore.riskMode,
        reasoning,
        editOf: editingMessageId ?? undefined,
      };
      const submission = await send(input);
      releaseImageAttachments(submittedAttachments);
      if (editingMessageId === input.editOf) {
        releaseImageAttachments(preEditDraft?.attachments ?? []);
        editingMessageId = null;
        preEditDraft = null;
      }
      requestAnimationFrame(() => resizeComposer());
    } catch (error) {
      if (!draft) draft = submittedDraft;
      if (!attachments.length) attachments = submittedAttachments;
      requestAnimationFrame(() => resizeComposer());
      if (error instanceof DOMException && error.name === "AbortError") return;
      notice = errorText(error) || t("assistant.error.send", "Message could not be sent. Check the active model and try again.");
    }
  }

  function resizeComposer(element = composerInput): void {
    if (!element) return;
    element.style.height = "0px";
    const styles = getComputedStyle(element);
    const minimum = Number.parseFloat(styles.minHeight) || 42;
    const maximum = Number.parseFloat(styles.maxHeight) || 132;
    const contentHeight = element.scrollHeight;
    element.style.height = `${Math.min(maximum, Math.max(minimum, contentHeight))}px`;
    element.style.overflowY = contentHeight > maximum ? "auto" : "hidden";
  }

  function beginEdit(message: ChatMessage): void {
    if (!editingMessageId) preEditDraft = { text: draft, attachments: [...attachments] };
    else releaseImageAttachments(attachments);
    editingMessageId = message.id;
    draft = message.content;
    attachments = [...message.attachments];
    retainImageAttachments(attachments);
    notice = null;
    requestAnimationFrame(() => {
      resizeComposer();
      composerInput?.focus();
      composerInput?.setSelectionRange(draft.length, draft.length);
    });
  }

  function cancelEdit(): void {
    releaseImageAttachments(attachments);
    draft = preEditDraft?.text ?? "";
    attachments = [...(preEditDraft?.attachments ?? [])];
    editingMessageId = null;
    preEditDraft = null;
    requestAnimationFrame(() => resizeComposer());
  }

  function stop(): void {
    if (actionOverrides.stopRequest) actionOverrides.stopRequest();
    else if (controller) controller.actions.stopRequest();
    else $useChatStore.cancelRequest();
  }

  function openSettings(): void {
    actionOverrides.openSettings?.();
    returnToChatAfterSettings = kind !== "desktop" && $useUiStore.shellOpen;
    if (returnToChatAfterSettings) $useUiStore.setShellOpen(false);
    $useUiStore.setProfileSettingsOpen(true);
    $useUiStore.bringToFront("profiles");
  }

  function closeSettings(): void {
    $useUiStore.setProfileSettingsOpen(false);
    if (returnToChatAfterSettings) {
      returnToChatAfterSettings = false;
      $useUiStore.setShellOpen(true);
      $useUiStore.bringToFront("chat");
    }
  }

  async function toggleRiskMode(): Promise<void> {
    if ($useUiStore.riskMode !== "yolo") {
      confirm = "yolo";
      return;
    }
    try {
      await action("setRiskMode")("normal");
      $useUiStore.setRiskMode("normal");
    } catch (error) { notice = errorText(error); }
  }

  async function enableYolo(): Promise<void> {
    try {
      await action("setRiskMode")("yolo");
      $useUiStore.setRiskMode("yolo");
      confirm = null;
    } catch (error) { notice = errorText(error); }
  }

  function useSuggestion(text: string): void {
    draft = text;
    requestAnimationFrame(() => {
      resizeComposer();
      composerInput?.focus();
      composerInput?.setSelectionRange(draft.length, draft.length);
    });
  }

  function toggleHistory(): void {
    const next = !$useUiStore.historyOpen;
    $useUiStore.setHistoryOpen(next);
    if (next) {
      $useRuntimeStore.setLoading(true);
      void ensureControllerReady()
        .then((activeController) => {
          if (!activeController) return [];
          if ($useRuntimeStore.startup === "error") throw new Error($useRuntimeStore.error ?? t("assistant.runtime.retry", "The Loom runtime is starting or unavailable. Open chat history to retry, or check the sidecar configuration in Model profiles."));
          return activeController.loadHistory();
        })
        .then(async (rows) => {
          if (rows.some((row) => row.source === "KT")) return;
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          await controller?.loadHistory();
        })
        .then(() => $useRuntimeStore.setError(null))
        .catch((error) => $useRuntimeStore.setError(error instanceof Error ? error.message : t("assistant.error.history", "Chat history could not be loaded. Try again.")))
        .finally(() => $useRuntimeStore.setLoading(false));
    }
  }

  async function createNewSession(): Promise<void> {
    notice = null;
    const previousDraft = draft;
    const previousAttachments = [...attachments];
    const previousEditingMessageId = editingMessageId;
    const previousPreEditDraft = preEditDraft;
    try {
      if (actionOverrides.newSession) await actionOverrides.newSession();
      else {
        const activeController = await ensureControllerReady();
        if (!activeController) throw new Error("Kohaku Loom runtime controller is unavailable");
        await activeController.actions.newSession();
      }
      if (draft === previousDraft) draft = "";
      if (attachments.length === previousAttachments.length && attachments.every((item, index) => item.id === previousAttachments[index]?.id)) {
        attachments = [];
        releaseImageAttachments(previousAttachments);
      }
      if (editingMessageId === previousEditingMessageId) editingMessageId = null;
      if (preEditDraft === previousPreEditDraft) {
        releaseImageAttachments(previousPreEditDraft?.attachments ?? []);
        preEditDraft = null;
      }
    } catch (error) {
      notice = error instanceof Error ? error.message : t("assistant.error.new_chat", "A new chat could not be started. Stop the current response and try again.");
    }
  }

  async function newSession(): Promise<void> {
    if (sessionTransition) return sessionTransition;
    const pending = createNewSession();
    sessionTransition = pending;
    try { await pending; } finally { if (sessionTransition === pending) sessionTransition = null; }
  }

  async function addFiles(files: File[]): Promise<void> {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      notice = t("assistant.error.image_only", "Only image files can be attached.");
      return;
    }
    const remaining = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (!remaining) {
      notice = tf("assistant.error.image_limit", "You can attach up to {count} images.", { count: MAX_ATTACHMENTS });
      return;
    }
    const accepted = images.slice(0, remaining);
    notice = images.length > accepted.length ? tf("assistant.error.image_limit_first", "Only the first {count} images were attached.", { count: MAX_ATTACHMENTS }) : null;
    const added: PreparedImageAttachment[] = [];
    try {
      for (const file of accepted) {
        const attachment = await createImageAttachment(file, id("attachment"));
        assertAttachmentTotal([...attachments, ...added, attachment]);
        added.push(attachment);
      }
      await action("attachFiles")(accepted);
      attachments = [...attachments, ...added];
    } catch (error) {
      releaseImageAttachments(added);
      notice = error instanceof Error ? error.message : t("assistant.error.attach", "The images could not be attached. Try them again.");
    }
  }

  async function replaceAttachment(file: File): Promise<void> {
    if (!replacementId) return;
    const next = await createImageAttachment(file, id("attachment"));
    try {
      assertAttachmentTotal(attachments.map((item) => item.id === replacementId ? next : item));
      await action("replaceAttachment")(replacementId, file);
      const previous = attachments.find((item) => item.id === replacementId);
      attachments = attachments.map((item) => item.id === replacementId ? next : item);
      if (previous) releaseImageAttachment(previous);
      replacementId = null;
    } catch (error) {
      releaseImageAttachment(next);
      throw error;
    }
  }

  async function removeAttachment(attachmentId: string): Promise<void> {
    await action("removeAttachment")(attachmentId);
    const removed = attachments.find((item) => item.id === attachmentId);
    if (lightbox?.attachments.some((item) => item.id === attachmentId)) lightbox = null;
    attachments = attachments.filter((item) => item.id !== attachmentId);
    if (removed) releaseImageAttachment(removed);
  }

  async function copyMessage(message: ChatMessage): Promise<void> {
    await action("copyMessage")(message);
    copiedId = message.id;
    window.setTimeout(() => { if (copiedId === message.id) copiedId = null; }, 1200);
  }

  function resizeKey(event: KeyboardEvent): void {
    const delta = event.shiftKey ? 40 : 10;
    const width = event.key === "ArrowRight" ? delta : event.key === "ArrowLeft" ? -delta : 0;
    const height = event.key === "ArrowDown" ? delta : event.key === "ArrowUp" ? -delta : 0;
    if (!width && !height) return;
    event.preventDefault();
    updateLayout(clampWindowLayout({ ...currentLayout, width: currentLayout.width + width, height: currentLayout.height + height }, viewport, windowMinimum));
  }

  onMount(() => {
    let focusRecoveryTimer: number | undefined;
    const recoverAfterFocus = () => {
      window.clearTimeout(focusRecoveryTimer);
      focusRecoveryTimer = window.setTimeout(refreshViewport, 80);
    };
    attachments = [...initialAttachments];
    syncReasoningFromProfile();
    if (initialOpen) $useUiStore.setShellOpen(true);
    void ensureControllerReady().catch(() => undefined);
    window.addEventListener("resize", refreshViewport);
    window.visualViewport?.addEventListener("resize", refreshViewport);
    window.visualViewport?.addEventListener("scroll", refreshViewport);
    document.addEventListener("focusin", refreshViewport);
    document.addEventListener("focusout", recoverAfterFocus);
    return () => {
      window.clearTimeout(focusRecoveryTimer);
      window.removeEventListener("resize", refreshViewport);
      window.visualViewport?.removeEventListener("resize", refreshViewport);
      window.visualViewport?.removeEventListener("scroll", refreshViewport);
      document.removeEventListener("focusin", refreshViewport);
      document.removeEventListener("focusout", recoverAfterFocus);
      controllerAbort?.abort();
      controllerAbort = null;
      controller?.destroy();
      controller = null;
      controllerReady = null;
      releaseImageAttachments(attachments);
      releaseImageAttachments(preEditDraft?.attachments ?? []);
    };
  });

  $effect(() => {
    activeProfile?.parameters.reasoningEffort;
    activeProfile?.capabilities.reasoning;
    syncReasoningFromProfile();
  });
</script>

<div class="kl-surface kl-viewport-{kind}" data-kohaku-loom-surface="true">
  {#if !$useUiStore.shellOpen && !$useUiStore.profileSettingsOpen}
    <button
      class:kl-launcher-interacting={launcherInteracting}
      class="kl-launcher"
      type="button"
      aria-label={t("assistant.open", "Open Kohaku Loom")}
      aria-expanded="false"
      title={t("assistant.drag", "Drag to move")}
      style:left={$useUiStore.launcherPosition ? `${$useUiStore.launcherPosition.left}px` : undefined}
      style:top={$useUiStore.launcherPosition ? `${$useUiStore.launcherPosition.top}px` : undefined}
      style:right={$useUiStore.launcherPosition ? "auto" : undefined}
      style:bottom={$useUiStore.launcherPosition ? "auto" : undefined}
      use:pointerPosition={{ position: () => $useUiStore.launcherPosition, update: updateLauncherPosition, interacting: (active) => launcherInteracting = active, moved: (moved) => launcherDragged = moved }}
      onclick={openLauncher}
    >
      <Sparkles size={15} />
      <span>{t("assistant.launcher", "Assistant")}</span>
    </button>
  {/if}

  {#if $useUiStore.shellOpen}
    <div
      class:kl-window-interacting={interacting}
      class="kl-window"
      style:left="{currentLayout.left}px"
      style:top="{currentLayout.top}px"
      style:width="{currentLayout.width}px"
      style:height="{currentLayout.height}px"
      style:z-index={$useUiStore.frontWindow === "chat" ? 1002 : 1000}
      role="dialog"
      aria-modal="false"
      aria-label={t("assistant.chat_dialog", "Kohaku Loom chat")}
      tabindex="-1"
      data-pending="false"
      onpointerdown={() => $useUiStore.bringToFront("chat")}
      onkeydown={(event) => { if (event.key === "Escape") $useUiStore.setShellOpen(false); }}
    >
      <header class="kl-window-header" use:pointerWindow={{ mode: "drag", layout: () => currentLayout, update: updateLayout, minimum: windowMinimum, interacting: (active) => interacting = active }}>
        <div class="kl-chat-title"><strong>{t("assistant.title", "Assistant")}</strong></div>
        <div class="kl-header-controls">
          <div class="kl-history-anchor">
            <button type="button" class="kl-header-icon" aria-label={t("history.open", "Open chat history")} aria-expanded={$useUiStore.historyOpen} onclick={toggleHistory}><History size={16} /></button>
            {#if $useUiStore.historyOpen}
              <div class="kl-history-popover" role="dialog" tabindex="-1" aria-label={t("history.title", "Chat history")} onkeydown={(event) => { if (event.key === "Escape") { event.stopPropagation(); $useUiStore.setHistoryOpen(false); } }}>
                <div class="kl-history-heading"><div><span class="kl-eyebrow">{t("history.archive", "Archive")}</span><strong>{t("history.title", "Chat history")}</strong></div><span class="kl-history-count">{filteredHistory.length}</span></div>
                <label class="kl-history-search"><Search size={14} /><input bind:value={historySearch} placeholder={t("history.search", "Search sessions")} aria-label={t("history.search_label", "Search chat history")} /></label>
                <div class="kl-history-list" role="listbox" aria-label={t("history.sessions", "Chat history sessions")}>
                  {#if runtimeUnavailable}<p class="kl-history-empty" role="status">{t("assistant.runtime.disconnected", "The Loom runtime is not connected. Open Model profiles and retry the connection.")}</p>{:else}{#if $useRuntimeStore.loading}<p class="kl-history-empty" role="status">{t("history.loading", "Loading chat history…")}</p>{/if}{#each filteredHistory as row (row.id)}
                    <button type="button" class="kl-history-row" aria-label={row.title} role="option" aria-selected="false" onclick={() => { void action("selectHistory")(row); $useUiStore.setHistoryOpen(false); }}>
                      <span class="kl-history-source kl-history-source-{row.source.toLowerCase()}">{#if row.source === "KT"}<Clock3 size={12} />{:else}<FileArchive size={12} />{/if}{row.source}</span>
                      <span class="kl-history-row-main"><strong>{row.title}</strong><small>{row.preview || t("history.no_preview", "No preview")}</small></span>
                      <span class="kl-history-row-meta"><time>{row.updatedAt}</time><small>{tf("history.message_count", "{count} messages", { count: row.messageCount })}</small></span>
                    </button>
                  {:else}<p class="kl-history-empty">{t("history.empty_search", "No sessions match that search.")}</p>{/each}{/if}
                </div>
              </div>
            {/if}
          </div>
          <button type="button" class="kl-header-icon" onclick={() => void newSession()} aria-label={t("assistant.new_chat", "Start a new chat")} title={t("assistant.new_chat", "Start a new chat")} disabled={Boolean($useChatStore.activeRequestId)}><SquarePen size={16} /></button>
          <button type="button" class="kl-header-icon" onclick={openSettings} aria-label={t("assistant.open_settings", "Open settings")}><Settings2 size={16} /></button>
          <button type="button" class="kl-header-icon kl-header-close" onclick={() => $useUiStore.setShellOpen(false)} aria-label={t("assistant.close_window", "Close Kohaku Loom")}><X size={16} /></button>
        </div>
      </header>

        <div class="kl-window-body">
        {#if connectionState === "connecting"}<div class="kl-inline-alert" role="status" aria-live="polite"><RefreshCw size={15} /><span>Connecting to Forge runtime…</span></div>{:else if connectionState === "failed"}<div class="kl-inline-alert" role="alert"><AlertTriangle size={15} /><span>{connectionError}</span><button type="button" onclick={() => void ensureControllerReady().catch(() => undefined)}>Retry</button></div>{:else if runtimeStarting}<div class="kl-inline-alert" role="status" aria-live="polite"><RefreshCw size={15} /><span>{t("assistant.runtime.retry", "The Loom runtime is starting or unavailable. Open chat history to retry, or check the sidecar configuration in Model profiles.")}</span></div>{/if}
        {#if $useRuntimeStore.error || notice}<div class="kl-inline-alert" role="alert"><AlertTriangle size={15} /><span>{runtimeErrorText(notice || $useRuntimeStore.error || "")}</span>{#if notice}<button type="button" onclick={() => notice = null} aria-label={t("common.dismiss_message", "Dismiss message")}><X size={14} /></button>{/if}</div>{/if}
        <div class="kl-message-scroll" role="log" aria-live="polite" aria-busy={Boolean($useChatStore.activeRequestId)}>
          {#if visibleMessages.length > 0}
            {#each visibleMessages as message (message.id)}
              <article
                class:kl-message-user={message.role === "user"}
                class:kl-message-assistant={message.role === "assistant"}
                class:kl-message-tool={message.role === "tool"}
                class:kl-message-error={message.role === "error"}
                class:kl-message-system={message.role === "system"}
                class:kl-message-streaming={message.status === "streaming"}
                class:kl-message-cancelled={message.status === "cancelled"}
                class="kl-message-card"
                data-message-id={message.id}
              >
                <div class="kl-message-heading"><span class="kl-message-role">
                  {#if message.role === "user"}<UserRound size={15} />{:else if message.role === "tool"}<Wrench size={15} />{:else if message.role === "error"}<XCircle size={15} />{:else if message.role === "assistant"}<Bot size={15} />{:else}<FileCog size={15} />{/if}
                  {roleLabel(message)}
                </span><span class="kl-message-meta">
                  {#if message.status === "streaming"}<span class="kl-status-marker kl-status-streaming">{t("chat.status.partial", "Generating")}</span>{:else if message.status === "cancelled"}<span class="kl-status-marker kl-status-cancelled"><XCircle size={12} /> {t("chat.status.cancelled", "Cancelled")}</span>{:else if message.status === "error"}<span class="kl-status-marker kl-status-error">{t("chat.status.error", "Error")}</span>{/if}
                  {#if message.usage}<span class="kl-usage"><Clipboard size={11} /> {[message.usage.inputTokens !== undefined ? `${message.usage.inputTokens} in` : "", message.usage.outputTokens !== undefined ? `${message.usage.outputTokens} out` : "", message.usage.latencyMs !== undefined ? `${(message.usage.latencyMs / 1000).toFixed(1)}s` : ""].filter(Boolean).join(" · ")}</span>{/if}
                  {#if message.role === "assistant"}<button type="button" class="kl-message-collapse" onclick={() => toggleMessage(message.id)} aria-label={collapsedMessageIds.has(message.id) ? t("chat.expand", "Expand response") : t("chat.collapse", "Collapse response")}>{#if collapsedMessageIds.has(message.id)}<ChevronRight size={14} />{:else}<ChevronLeft size={14} />{/if}</button>{/if}
                </span></div>
                {#if message.role === "tool"}
                  <details class="kl-tool-card" data-tool-result="true">
                    <summary>
                      <span class="kl-tool-title"><ChevronRight size={14} aria-hidden="true" /><strong>{message.tool?.name ?? t("chat.tool_call", "Tool call")}</strong></span>
                      <span class:kl-tool-status-error={message.tool?.status === "error"} class="kl-tool-status">{t(`chat.tool_status.${message.tool?.status ?? "complete"}`, message.tool?.status ?? "complete")}</span>
                    </summary>
                    <div class="kl-tool-result">
                      {#if message.tool?.detail}<p>{message.tool.detail}</p>{/if}
                      {#if message.content}<Markdown content={message.content} streaming={message.status === "streaming"} />{/if}
                    </div>
                  </details>
                {:else if collapsedMessageIds.has(message.id)}<button type="button" class="kl-message-collapsed-preview" onclick={() => toggleMessage(message.id)}>{reasoningPreview(message.content)}</button>{:else}<Markdown content={message.content} streaming={message.status === "streaming"} />{/if}
                {#if message.reasoning && !collapsedMessageIds.has(message.id)}
                  <details class:kl-reasoning-streaming={message.status === "streaming"} class="kl-reasoning">
                    <summary>
                      <span class="kl-reasoning-label">{t("chat.reasoning_trace", "Reasoning trace")}</span>
                      <span class="kl-reasoning-preview" title={reasoningPreview(message.reasoning)}>{reasoningPreview(message.reasoning)}</span>
                    </summary>
                    <div class="kl-reasoning-content"><Markdown content={message.reasoning} streaming={message.status === "streaming"} /></div>
                  </details>
                {/if}
                {#if message.attachments.length && !collapsedMessageIds.has(message.id)}<div class="kl-message-attachments" aria-label={tf("assistant.reference_images", "{count} reference images", { count: message.attachments.length })}>{#each message.attachments as attachment, index (attachment.id)}<button type="button" class="kl-message-attachment" onclick={() => lightbox = { attachments: message.attachments, index }} aria-label={tf("assistant.preview_named", "Preview {name}", { name: attachment.name })}><img src={attachmentPreviewUrl(attachment)} alt={attachment.name} width="58" height="48" loading="lazy" /></button>{/each}</div>{/if}
                <div class="kl-message-footer"><div class="kl-message-actions"><button type="button" class="kl-message-action" onclick={() => void copyMessage(message)}>{#if copiedId === message.id}<Check size={13} /> {t("chat.copied", "Copied")}{:else}<Copy size={13} /> {t("chat.copy", "Copy")}{/if}</button>{#if message.role === "user"}<button type="button" class="kl-message-action" disabled={Boolean($useChatStore.activeRequestId)} onclick={() => beginEdit(message)}><Pencil size={13} /> {t("chat.edit", "Edit")}</button>{/if}{#if message.id === lastAssistantId}<button type="button" class="kl-message-action" onclick={() => void action("regenerate")(message)}><RefreshCw size={13} /> {t("chat.regenerate", "Regenerate")}</button>{/if}</div>
                  {#if (message.role === "assistant" || message.role === "user") && message.branchCount > 1}<div class="kl-branch-pager" aria-label={message.role === "user" ? t("branches.message_versions", "Message versions") : t("branches.assistant_responses", "Assistant response branches")}><button type="button" class="kl-mini-button" disabled={message.branchIndex === 0} onclick={() => void action("changeBranch")(message, message.branchIndex - 1)} aria-label={t("branches.previous", "Previous branch")}><ChevronLeft size={14} /></button><span>{message.branchIndex + 1} / {message.branchCount}</span><button type="button" class="kl-mini-button" disabled={message.branchIndex >= message.branchCount - 1} onclick={() => void action("changeBranch")(message, message.branchIndex + 1)} aria-label={t("branches.next", "Next branch")}><ChevronRight size={14} /></button></div>{/if}
                </div>
              </article>
            {/each}
          {:else}
            <div class="kl-empty-state"><Sparkles size={20} aria-hidden="true" /><strong>{t("assistant.empty.title", "Start with the current prompt")}</strong><p>{t("assistant.empty.hint", "Ask Loom to review composition, rewrite a prompt, inspect installed resources, or attach reference images.")}</p><div><button type="button" onclick={() => useSuggestion(t("assistant.quick.review_prompt", "Read the current prompt and suggest the highest-impact improvement."))}>{t("assistant.quick.review", "Review current prompt")}</button><button type="button" onclick={() => fileInput?.click()}>{t("assistant.quick.reference", "Analyze reference images")}</button></div></div>
          {/if}
          {#if $useChatStore.activeRequestId && workingPhase !== "idle"}<WorkingIndicator phase={workingPhase} tool={$useRuntimeStore.workingTool} statusDetail={$useRuntimeStore.workingDetail} reasoning={workingReasoning} />{/if}
        </div>

        {#if $useChatStore.queue.length}<div class="kl-queue-strip" aria-label={t("queue.messages", "Queued messages")}>{#if $useRuntimeStore.queuePaused}<div class="kl-queue-status" role="status">{t("queue.paused", "Queue is paused. Retry a failed message to resume.")}</div>{/if}<span class="kl-queue-label"><span class="kl-queue-dot"></span> {t("queue.label", "Queue")} {$useChatStore.queue.length}</span><div class="kl-queue-items">{#each $useChatStore.queue as item (item.id)}<div class="kl-queue-item"><span>{item.text || tf("queue.image_count", "{count} images", { count: Math.max(item.attachmentCount, item.attachments.length) })}</span>{#if item.state === "failed"}<button type="button" onclick={() => { if (actionOverrides.retryQueuedMessage) void actionOverrides.retryQueuedMessage(item.id); else if (controller) void controller.actions.retryQueuedMessage?.(item.id); }} aria-label={tf("queue.retry", "Retry queued message {id}", { id: item.id })}>{t("common.retry", "Retry")}</button>{/if}<button type="button" onclick={() => { if (actionOverrides.removeQueuedMessage) actionOverrides.removeQueuedMessage(item.id); else if (controller) void controller.actions.removeQueuedMessage(item.id); else $useChatStore.removeQueuedMessage(item.id); }} aria-label={tf("queue.remove", "Remove queued message {id}", { id: item.id })}><XCircle size={13} /></button></div>{/each}</div></div>{/if}

        <form class:kl-composer-drop-active={dropActive} class="kl-composer" onsubmit={(event) => { event.preventDefault(); void submit(); }} ondragover={(event) => { event.preventDefault(); dropActive = true; }} ondragleave={() => dropActive = false} ondrop={(event) => { event.preventDefault(); dropActive = false; void addFiles(Array.from(event.dataTransfer?.files ?? [])); }}>
          {#if editingMessageId}<div class="kl-editing-banner" role="status"><span><Pencil size={13} /> {t("chat.editing", "Editing message")}</span><button type="button" onclick={cancelEdit}>{t("chat.cancel_edit", "Cancel")}</button></div>{/if}
          {#if attachments.length}<div class="kl-filmstrip" aria-label={t("assistant.attached_images", "Attached reference images")}>{#each attachments as attachment, index (attachment.id)}<div class="kl-filmstrip-item"><button type="button" class="kl-filmstrip-preview" onclick={() => lightbox = { attachments, index }} oncontextmenu={(event) => { event.preventDefault(); attachmentMenuId = attachment.id; }} aria-label={tf("assistant.preview_named", "Preview {name}", { name: attachment.name })}><img src={attachmentPreviewUrl(attachment)} alt={attachment.name} width="58" height="54" /><span class="kl-filmstrip-name">{attachment.name}</span></button><button type="button" class="kl-filmstrip-remove" onclick={() => void removeAttachment(attachment.id)} aria-label={tf("assistant.remove_named", "Remove {name}", { name: attachment.name })}><X size={12} /></button><button type="button" class="kl-filmstrip-more" onclick={() => attachmentMenuId = attachmentMenuId === attachment.id ? null : attachment.id} aria-label={tf("assistant.edit_named", "Edit {name}", { name: attachment.name })}>•••</button>{#if attachmentMenuId === attachment.id}<div class="kl-attachment-menu" role="menu"><button type="button" role="menuitem" onclick={() => { replacementId = attachment.id; replacementInput?.click(); attachmentMenuId = null; }}><Pencil size={13} /> {t("common.replace", "Replace")}</button><button type="button" role="menuitem" onclick={() => { void removeAttachment(attachment.id); attachmentMenuId = null; }}><Trash2 size={13} /> {t("common.remove", "Remove")}</button></div>{/if}</div>{/each}<button type="button" class="kl-filmstrip-add" onclick={() => fileInput?.click()} aria-label={t("assistant.attach_another", "Attach another image")}><Plus size={17} /></button></div>{/if}
          <textarea name="kohaku-loom-message" autocomplete="off" bind:this={composerInput} bind:value={draft} rows="1" placeholder={t("assistant.input.placeholder", "Ask about or change the current prompt…")} aria-label={t("assistant.input.label", "Message Kohaku Loom")} oninput={(event) => resizeComposer(event.currentTarget)} onkeydown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if ($useChatStore.activeRequestId) stop(); else void submit(); } }}></textarea>
          <div class="kl-composer-bottom"><div class="kl-composer-tools"><button type="button" class="kl-composer-icon" onclick={() => fileInput?.click()} aria-label={t("assistant.attach", "Attach reference images")}><ImagePlus size={16} /></button></div>
             <div class="kl-composer-tools"><div class="kl-composer-picker-row" aria-label={t("assistant.model_controls", "Model controls")}><ModelPicker /><ReasoningPicker /></div><button type="button" class:is-direct={$useUiStore.riskMode === "yolo"} class="kl-permission-toggle" onclick={toggleRiskMode} aria-label={$useUiStore.riskMode === "yolo" ? t("assistant.risk.mode_direct", "Permission mode: direct edits") : t("assistant.risk.mode_confirm", "Permission mode: confirmations required")} title={$useUiStore.riskMode === "yolo" ? t("assistant.risk.confirm", "Require confirmation before edits") : t("assistant.risk.direct", "Allow direct edits")} aria-pressed={$useUiStore.riskMode === "yolo"}>{#if $useUiStore.riskMode === "yolo"}<ShieldAlert size={17} aria-hidden="true" />{:else}<ShieldCheck size={17} aria-hidden="true" />{/if}</button>{#if $useChatStore.activeRequestId}<button type="submit" class="kl-send-button kl-queue-button" disabled={!draft.trim() && !attachments.length} aria-label={t("assistant.queue", "Queue message")}><Send size={17} /></button><button type="button" class="kl-send-button kl-stop-button" onclick={stop} disabled={$useRuntimeStore.workingPhase === "cancelling"} aria-label={t("assistant.stop", "Stop response")}><CircleStop size={17} /></button>{:else}<button type="submit" class="kl-send-button" disabled={!draft.trim() && !attachments.length} aria-label={t("assistant.send", "Send message")}><Send size={17} /></button>{/if}</div>
           </div>
           {#if $useUiStore.riskMode === "yolo"}<p class="kl-risk-note"><AlertTriangle size={13} /> {t("assistant.risk.note", "Direct edits lets Loom change prompts and run tools without asking each time.")}</p>{/if}
          <input bind:this={fileInput} type="file" accept="image/*" multiple hidden onchange={(event) => { void addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
          <input bind:this={replacementInput} type="file" accept="image/*" hidden onchange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void replaceAttachment(file); event.currentTarget.value = ""; }} />
        </form>
      </div>
      <AlertDialog.Root open={confirm === "yolo"} onOpenChange={(value) => { if (!value) confirm = null; }}><AlertDialog.Overlay class="kl-window-dialog-layer" /><AlertDialog.Content class="kl-window-dialog-card kl-dialog-card"><header><AlertDialog.Title>{t("dialog.yolo.title", "Allow direct edits?")}</AlertDialog.Title></header><AlertDialog.Description class="kl-dialog-description">{t("dialog.yolo.description", "Loom may change the active prompt and run supported tools without asking for confirmation each time. Hash checks still protect prompts changed elsewhere.")}</AlertDialog.Description><div class="kl-dialog-actions"><AlertDialog.Cancel class="kl-dialog-cancel">{t("dialog.yolo.cancel", "Keep confirmations")}</AlertDialog.Cancel><AlertDialog.Action class="kl-dialog-confirm" onclick={enableYolo}>{t("dialog.yolo.confirm", "Allow direct edits")}</AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Root>
      <button type="button" class="kl-resize-handle" data-loom-interaction-handle="true" use:pointerWindow={{ mode: "resize", layout: () => currentLayout, update: updateLayout, minimum: windowMinimum, interacting: (active) => interacting = active }} onkeydown={resizeKey} aria-label={t("assistant.resize", "Resize chat window")}><Grip size={15} /></button>
    {#if kind !== "desktop" && !$useUiStore.hasSeenMobileResizeHint && !mobileHintDismissed}<div class="kl-mobile-resize-hint" role="status"><Grip size={14} /> {t("assistant.resize_hint", "Drag the corner to resize")}<button type="button" onclick={() => { mobileHintDismissed = true; $useUiStore.markMobileResizeHintSeen(); }}>{t("common.dismiss", "Dismiss")}</button></div>{/if}
    </div>
  {/if}

  <ProfileSettings open={$useUiStore.profileSettingsOpen} onclose={closeSettings} />

  <AlertDialog.Root open={Boolean(pendingToolApproval)} onOpenChange={(value) => { if (!value && pendingToolApproval) action("rejectTool")?.(pendingToolApproval.requestId); }}><AlertDialog.Portal><AlertDialog.Overlay class="kl-dialog-layer" /><AlertDialog.Content class="kl-dialog-card"><header><AlertDialog.Title>{t("dialog.tool.title", "Approve tool action?")}</AlertDialog.Title></header>{#if pendingToolApproval}<AlertDialog.Description class="kl-dialog-description"><strong>{pendingToolApproval.name}</strong><pre>{JSON.stringify(pendingToolApproval.arguments, null, 2)}</pre></AlertDialog.Description><div class="kl-dialog-actions"><AlertDialog.Cancel class="kl-dialog-cancel" onclick={() => action("rejectTool")?.(pendingToolApproval.requestId)}>{t("dialog.tool.reject", "Reject")}</AlertDialog.Cancel><AlertDialog.Action class="kl-dialog-confirm" onclick={() => action("approveTool")?.(pendingToolApproval.requestId)}>{t("dialog.tool.approve", "Approve")}</AlertDialog.Action></div>{/if}</AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>

  {#if lightbox && lightbox.attachments[lightbox.index]}
    <div class="kl-lightbox" role="dialog" tabindex="-1" aria-modal="true" aria-label={t("lightbox.title", "Image preview")} onclick={() => lightbox = null} onkeydown={(event) => { if (event.key === "Escape") lightbox = null; }}>
      <div class="kl-lightbox-panel" onclick={(event) => event.stopPropagation()} role="presentation"><button type="button" class="kl-lightbox-close" onclick={() => lightbox = null} aria-label={t("lightbox.close", "Close preview")}><X size={18} /></button><img src={attachmentPreviewUrl(lightbox.attachments[lightbox.index])} alt={lightbox.attachments[lightbox.index].name} width="900" height="900" />{#if lightbox.attachments.length > 1}<button type="button" class="kl-lightbox-nav kl-lightbox-prev" disabled={lightbox.index === 0} onclick={() => lightbox && (lightbox = { ...lightbox, index: Math.max(0, lightbox.index - 1) })} aria-label={t("lightbox.previous", "Previous image")}><ChevronLeft size={22} /></button><button type="button" class="kl-lightbox-nav kl-lightbox-next" disabled={lightbox.index === lightbox.attachments.length - 1} onclick={() => lightbox && (lightbox = { ...lightbox, index: Math.min(lightbox.attachments.length - 1, lightbox.index + 1) })} aria-label={t("lightbox.next", "Next image")}><ChevronRight size={22} /></button><span class="kl-lightbox-count">{lightbox.index + 1} / {lightbox.attachments.length}</span>{/if}</div>
    </div>
  {/if}
</div>
