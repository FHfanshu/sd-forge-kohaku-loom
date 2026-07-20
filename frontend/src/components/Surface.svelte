<script lang="ts">
  import { onMount } from "svelte";
  import {
    AlertTriangle, Bot, Check, ChevronLeft, ChevronRight,
    CircleStop, Clipboard, Clock3, Copy, FileCog, Grip, History,
    ImagePlus, Pencil, Plus, RefreshCw, Search, Send, Settings2,
    Sparkles, SquarePen, Trash2, UserRound, X,
    XCircle,
  } from "lucide-svelte";
  import type {
    ChatAttachment, ChatMessage, HistoryRow, PromptAgentActionHandlers, MessageSubmission,
    ReasoningEffort, SendMessageInput,
  } from "../contracts";
  import {
    AttachmentError, attachmentPreviewUrl,
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
  import type { PromptAgentController } from "../agent/controller";
  import { connectPromptAgentController } from "../runtime-connection";
  import { errorText } from "../errors";
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
  import ToolCard from "./ToolCard.svelte";
  import WorkingIndicator from "./WorkingIndicator.svelte";

  interface Props {
    messages?: ChatMessage[];
    history?: HistoryRow[];
    actions?: Partial<PromptAgentActionHandlers>;
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
  let composerFocused = $state(false);
  let replacementInput = $state<HTMLInputElement>();
  let replacementId = $state<string | null>(null);
  let attachmentMenuId = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let returnToChatAfterSettings = $state(false);
  let controller = $state<PromptAgentController | null>(null);
  let controllerReady: Promise<PromptAgentController> | null = null;
  let controllerAbort: AbortController | null = null;
  let connectionState = $state<"idle" | "connecting" | "ready" | "failed">("idle");
  let connectionError = $state<string | null>(null);
  let sessionTransition: Promise<void> | null = null;
  let messageScroll = $state<HTMLDivElement>();
  let followLatest = $state(true);
  let wasShellOpen = false;

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
  const workingPhase = $derived($useRuntimeStore.workingPhase);
  const workingReasoning = $derived([...visibleMessages].reverse().find((message) => message.role === "assistant" && message.status === "streaming" && message.reasoning)?.reasoning ?? "");
  const runtimeStarting = $derived($useRuntimeStore.startup === "starting");
  const renderMessages = $derived.by(() => {
    const groups: Array<{ message: ChatMessage; tools: ChatMessage[] }> = [];
    const pendingTools: ChatMessage[] = [];

    for (const message of visibleMessages) {
      if (message.role === "tool") {
        pendingTools.push(message);
        continue;
      }
      const group = { message, tools: [] as ChatMessage[] };
      if (message.role === "assistant" && pendingTools.length) {
        group.tools.push(...pendingTools.splice(0));
      }
      groups.push(group);
    }

    return { groups, pendingTools };
  });

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
    return value;
  }

  function megabytes(bytes = 0): string {
    return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 1 : 2);
  }

  function attachmentErrorText(error: unknown): string {
    if (!(error instanceof AttachmentError)) return errorText(error);
    const name = error.details.name ?? t("assistant.attachment.unknown", "This image");
    const limit = megabytes(error.details.limitBytes);
    if (error.code === "source_too_large") return tf("assistant.error.image_source_too_large", "{name} is larger than {limit} MB. Choose a smaller image.", { name, limit });
    if (error.code === "optimized_too_large") return tf("assistant.error.image_optimized_too_large", "{name} is still larger than {limit} MB after optimization. Resize or recompress it and try again.", { name, limit });
    if (error.code === "total_too_large") return tf("assistant.error.image_total_too_large", "The attached images total {total} MB, above the {limit} MB sending limit. Remove an image or use smaller files; your draft and attachments were kept.", { total: megabytes(error.details.totalBytes), limit });
    if (error.code === "data_unavailable") return tf("assistant.error.image_data_unavailable", "The image data for {name} is no longer available. Remove it and attach the file again.", { name });
    return t("assistant.error.image_read_failed", "The image could not be read. Remove it and attach the file again.");
  }

  function scrollToLatest(force = false): void {
    if (!messageScroll || (!force && !followLatest)) return;
    requestAnimationFrame(() => {
      if (!messageScroll) return;
      messageScroll.scrollTop = messageScroll.scrollHeight;
    });
  }

  function updateFollowLatest(): void {
    if (!messageScroll) return;
    followLatest = messageScroll.scrollHeight - messageScroll.scrollTop - messageScroll.clientHeight < 72;
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

  async function ensureControllerReady(): Promise<PromptAgentController | null> {
    if (Object.keys(actionOverrides).length) return null;
    if (controller) return controller;
    if (controllerReady) return controllerReady;
    connectionState = "connecting";
    connectionError = null;
    const abort = new AbortController();
    controllerAbort = abort;
    const pending = connectPromptAgentController(abort.signal)
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

  function action<K extends keyof PromptAgentActionHandlers>(name: K): PromptAgentActionHandlers[K] {
    const resolved = actionOverrides[name] ?? controller?.actions[name];
    if (resolved) return resolved as PromptAgentActionHandlers[K];
    if (Object.keys(actionOverrides).length || ["attachFiles", "replaceAttachment", "removeAttachment", "copyMessage", "clearChat"].includes(name)) {
      return noopActions[name] as PromptAgentActionHandlers[K];
    }
    return (() => {
      notice = connectionError ?? "Prompt Agent is still connecting to the Forge runtime.";
      void ensureControllerReady().catch(() => undefined);
    }) as PromptAgentActionHandlers[K];
  }

  async function send(input: SendMessageInput): Promise<MessageSubmission | void> {
    if (actionOverrides.sendMessage) {
      return await actionOverrides.sendMessage(input);
    }
    const activeController = await ensureControllerReady();
    if (!activeController) throw new Error("Prompt Agent runtime controller is unavailable");
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
      assertAttachmentTotal(submittedAttachments);
      const input = {
        text: submittedDraft.trim(),
        attachments: await materializeImageAttachments(submittedAttachments),
        displayAttachments: submittedAttachments.map(displayImageAttachment),
        reasoning,
      };
      const submission = await send(input);
      releaseImageAttachments(submittedAttachments);
      requestAnimationFrame(() => resizeComposer());
    } catch (error) {
      if (!draft) draft = submittedDraft;
      if (!attachments.length) attachments = submittedAttachments;
      requestAnimationFrame(() => resizeComposer());
      if (error instanceof DOMException && error.name === "AbortError") return;
      notice = attachmentErrorText(error) || t("assistant.error.send", "Message could not be sent. Check the active model and try again.");
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

  function keepComposerFocus(event: PointerEvent): void {
    if (composerFocused && event.pointerType !== "mouse") event.preventDefault();
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
          if ($useRuntimeStore.startup === "error") throw new Error($useRuntimeStore.error ?? t("assistant.runtime.retry", "Prompt Agent is unavailable. Retry or check Model profiles."));
          return activeController.loadHistory();
        })
        .then(async (rows) => {
          if (rows.some((row) => row.source === "prompt-agent")) return;
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
    try {
      if (actionOverrides.newSession) await actionOverrides.newSession();
      else {
        const activeController = await ensureControllerReady();
        if (!activeController) throw new Error("Prompt Agent runtime controller is unavailable");
        await activeController.actions.newSession();
      }
      if (draft === previousDraft) draft = "";
      if (attachments.length === previousAttachments.length && attachments.every((item, index) => item.id === previousAttachments[index]?.id)) {
        attachments = [];
        releaseImageAttachments(previousAttachments);
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
      notice = attachmentErrorText(error) || t("assistant.error.attach", "The images could not be attached. Try them again.");
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

  async function undoToolMutation(message: ChatMessage): Promise<void> {
    notice = null;
    try {
      await action("undoToolMutation")(message);
    } catch (error) {
      notice = errorText(error) || t("assistant.error.undo", "The saved Forge state could not be restored.");
    }
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
    };
  });

  $effect(() => {
    activeProfile?.parameters.reasoningEffort;
    activeProfile?.capabilities.reasoning;
    syncReasoningFromProfile();
  });

  $effect(() => {
    const open = $useUiStore.shellOpen;
    const latest = visibleMessages.at(-1);
    latest?.id;
    latest?.content;
    latest?.reasoning;
    latest?.status;
    $useChatStore.activeRequestId;
    if (open) scrollToLatest(!wasShellOpen);
    wasShellOpen = open;
  });
</script>

<div class="pa-surface pa-viewport-{kind}" data-prompt-agent-surface="true">
  {#if !$useUiStore.shellOpen && !$useUiStore.profileSettingsOpen}
    <button
      class:pa-launcher-interacting={launcherInteracting}
      class="pa-launcher"
      type="button"
       aria-label={t("assistant.open", "Open Prompt Agent")}
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
       <span>{t("assistant.launcher", "Prompt Agent")}</span>
    </button>
  {/if}

  {#if $useUiStore.shellOpen}
    <div
      class:pa-window-interacting={interacting}
      class="pa-window"
      style:left="{currentLayout.left}px"
      style:top="{currentLayout.top}px"
      style:width="{currentLayout.width}px"
      style:height="{currentLayout.height}px"
      style:z-index={$useUiStore.frontWindow === "chat" ? 1002 : 1000}
      role="dialog"
      aria-modal="false"
       aria-label={t("assistant.chat_dialog", "Prompt Agent chat")}
      tabindex="-1"
      data-prompt-agent-pending="false"
      onpointerdown={() => $useUiStore.bringToFront("chat")}
      onkeydown={(event) => { if (event.key === "Escape") $useUiStore.setShellOpen(false); }}
    >
       <header class="pa-window-header" use:pointerWindow={{ mode: "drag", layout: () => currentLayout, update: updateLayout, minimum: windowMinimum, interacting: (active) => interacting = active }}>
         <div class="pa-chat-title"><strong>{t("assistant.title", "Prompt Agent")}</strong></div>
         <div class="pa-header-controls">
           <div class="pa-history-anchor">
             <button type="button" class="pa-header-icon" aria-label={t("history.open", "Open chat history")} aria-expanded={$useUiStore.historyOpen} onclick={toggleHistory}><History size={16} /></button>
            {#if $useUiStore.historyOpen}
               <div class="pa-history-popover" role="dialog" tabindex="-1" aria-label={t("history.title", "Chat history")} onkeydown={(event) => { if (event.key === "Escape") { event.stopPropagation(); $useUiStore.setHistoryOpen(false); } }}>
                 <div class="pa-history-heading"><div><span class="pa-eyebrow">{t("history.archive", "Archive")}</span><strong>{t("history.title", "Chat history")}</strong></div><span class="pa-history-count">{filteredHistory.length}</span></div>
                 <label class="pa-history-search"><Search size={14} /><input bind:value={historySearch} placeholder={t("history.search", "Search sessions")} aria-label={t("history.search_label", "Search chat history")} /></label>
                 <div class="pa-history-list" role="listbox" aria-label={t("history.sessions", "Chat history sessions")}>
                   {#if runtimeUnavailable}<p class="pa-history-empty" role="status">{t("assistant.runtime.disconnected", "The Prompt Agent runtime is not connected. Open Model profiles and retry the connection.")}</p>{:else}{#if $useRuntimeStore.loading}<p class="pa-history-empty" role="status">{t("history.loading", "Loading chat history…")}</p>{/if}{#each filteredHistory as row (row.id)}
                     <button type="button" class="pa-history-row" aria-label={row.title} role="option" aria-selected="false" onclick={() => { void action("selectHistory")(row); $useUiStore.setHistoryOpen(false); }}>
                       <span class="pa-history-source pa-history-source-{row.source.toLowerCase()}"><Clock3 size={12} />{row.source}</span>
                       <span class="pa-history-row-main"><strong>{row.title}</strong><small>{row.preview || t("history.no_preview", "No preview")}</small></span>
                       <span class="pa-history-row-meta"><time>{row.updatedAt}</time><small>{tf("history.message_count", "{count} messages", { count: row.messageCount })}</small></span>
                    </button>
                   {:else}<p class="pa-history-empty">{t("history.empty_search", "No sessions match that search.")}</p>{/each}{/if}
                </div>
              </div>
            {/if}
          </div>
           <button type="button" class="pa-header-icon" onclick={() => void newSession()} aria-label={t("assistant.new_chat", "Start a new chat")} title={t("assistant.new_chat", "Start a new chat")} disabled={Boolean($useChatStore.activeRequestId)}><SquarePen size={16} /></button>
           <button type="button" class="pa-header-icon" onclick={openSettings} aria-label={t("assistant.open_settings", "Open settings")}><Settings2 size={16} /></button>
           <button type="button" class="pa-header-icon pa-header-close" onclick={() => $useUiStore.setShellOpen(false)} aria-label={t("assistant.close_window", "Close Prompt Agent")}><X size={16} /></button>
        </div>
      </header>

        <div class="pa-window-body">
        {#if connectionState === "connecting"}<div class="pa-inline-alert" role="status" aria-live="polite"><RefreshCw size={15} /><span>Connecting to Forge runtime…</span></div>{:else if connectionState === "failed"}<div class="pa-inline-alert" role="alert"><AlertTriangle size={15} /><span>{connectionError}</span><button type="button" onclick={() => void ensureControllerReady().catch(() => undefined)}>Retry</button></div>{:else if runtimeStarting}<div class="pa-inline-alert" role="status" aria-live="polite"><RefreshCw size={15} /><span>{t("assistant.runtime.retry", "Prompt Agent is starting or unavailable. Retry or check Model profiles.")}</span></div>{/if}
        {#if $useRuntimeStore.error || notice}<div class="pa-inline-alert" role="alert"><AlertTriangle size={15} /><span>{runtimeErrorText(notice || $useRuntimeStore.error || "")}</span>{#if notice}<button type="button" onclick={() => notice = null} aria-label={t("common.dismiss_message", "Dismiss message")}><X size={14} /></button>{/if}</div>{/if}
        <div bind:this={messageScroll} class="pa-message-scroll" role="log" aria-live="polite" aria-busy={Boolean($useChatStore.activeRequestId)} onscroll={updateFollowLatest}>
           {#if visibleMessages.length > 0}
             {#each renderMessages.groups as group (group.message.id)}
               {@const message = group.message}
              <article
                class:pa-message-user={message.role === "user"}
                class:pa-message-assistant={message.role === "assistant"}
                class:pa-message-error={message.role === "error"}
                class:pa-message-system={message.role === "system"}
                class:pa-message-streaming={message.status === "streaming"}
                class:pa-message-cancelled={message.status === "cancelled"}
                class="pa-message-card"
                data-prompt-agent-message-id={message.id}
              >
                <div class="pa-message-heading"><span class="pa-message-role">
                   {#if message.role === "user"}<UserRound size={15} />{:else if message.role === "error"}<XCircle size={15} />{:else if message.role === "assistant"}<Bot size={15} />{:else}<FileCog size={15} />{/if}
                  {roleLabel(message)}
                </span><span class="pa-message-meta">
                  {#if message.status === "streaming"}<span class="pa-status-marker pa-status-streaming">{t("chat.status.partial", "Generating")}</span>{:else if message.status === "cancelled"}<span class="pa-status-marker pa-status-cancelled"><XCircle size={12} /> {t("chat.status.cancelled", "Cancelled")}</span>{:else if message.status === "error"}<span class="pa-status-marker pa-status-error">{t("chat.status.error", "Error")}</span>{/if}
                  {#if message.usage}<span class="pa-usage"><Clipboard size={11} /> {[message.usage.inputTokens !== undefined ? `${message.usage.inputTokens} in` : "", message.usage.outputTokens !== undefined ? `${message.usage.outputTokens} out` : "", message.usage.latencyMs !== undefined ? `${(message.usage.latencyMs / 1000).toFixed(1)}s` : ""].filter(Boolean).join(" · ")}</span>{/if}
                  {#if message.role === "assistant"}<button type="button" class="pa-message-collapse" onclick={() => toggleMessage(message.id)} aria-label={collapsedMessageIds.has(message.id) ? t("chat.expand", "Expand response") : t("chat.collapse", "Collapse response")}>{#if collapsedMessageIds.has(message.id)}<ChevronRight size={14} />{:else}<ChevronLeft size={14} />{/if}</button>{/if}
                </span></div>
                  {#if group.tools.length}<div class="pa-message-tools" aria-label={t("chat.tool_results", "Tool results")}>{#each group.tools as tool (tool.id)}<ToolCard message={tool} onundo={undoToolMutation} />{/each}</div>{/if}
                  {#if collapsedMessageIds.has(message.id)}<button type="button" class="pa-message-collapsed-preview" onclick={() => toggleMessage(message.id)}>{reasoningPreview(message.content)}</button>{:else}<Markdown content={message.content} streaming={message.status === "streaming"} />{/if}
                {#if message.reasoning && !collapsedMessageIds.has(message.id)}
                  <details class:pa-reasoning-streaming={message.status === "streaming"} class="pa-reasoning">
                    <summary>
                      <span class="pa-reasoning-label">{t("chat.reasoning_trace", "Reasoning trace")}</span>
                      <span class="pa-reasoning-preview" title={reasoningPreview(message.reasoning)}>{reasoningPreview(message.reasoning)}</span>
                    </summary>
                     <div class="pa-reasoning-content"><Markdown content={message.reasoning} streaming={message.status === "streaming"} renderStreamingMarkdown={true} /></div>
                  </details>
                 {/if}
                {#if message.attachments.length && !collapsedMessageIds.has(message.id)}<div class="pa-message-attachments" aria-label={tf("assistant.reference_images", "{count} reference images", { count: message.attachments.length })}>{#each message.attachments as attachment, index (attachment.id)}<button type="button" class="pa-message-attachment" onclick={() => lightbox = { attachments: message.attachments, index }} aria-label={tf("assistant.preview_named", "Preview {name}", { name: attachment.name })}><img src={attachmentPreviewUrl(attachment)} alt={attachment.name} width="58" height="48" loading="lazy" /></button>{/each}</div>{/if}
                 <div class="pa-message-footer"><div class="pa-message-actions"><button type="button" class="pa-message-action" onclick={() => void copyMessage(message)}>{#if copiedId === message.id}<Check size={13} /> {t("chat.copied", "Copied")}{:else}<Copy size={13} /> {t("chat.copy", "Copy")}{/if}</button></div></div>
               </article>
             {/each}
              {#each renderMessages.pendingTools as tool (tool.id)}<div class="pa-orphan-tools"><ToolCard message={tool} onundo={undoToolMutation} /></div>{/each}
          {:else}
             <div class="pa-empty-state"><Sparkles size={20} aria-hidden="true" /><strong>{t("assistant.empty.title", "Start with the current prompt")}</strong><p>{t("assistant.empty.hint", "Ask Prompt Agent to review composition, rewrite a prompt, inspect installed resources, or attach reference images.")}</p><div><button type="button" onclick={() => useSuggestion(t("assistant.quick.review_prompt", "Read the current prompt and suggest the highest-impact improvement."))}>{t("assistant.quick.review", "Review current prompt")}</button><button type="button" onclick={() => fileInput?.click()}>{t("assistant.quick.reference", "Analyze reference images")}</button></div></div>
          {/if}
          {#if $useChatStore.activeRequestId && workingPhase !== "idle"}<WorkingIndicator phase={workingPhase} tool={$useRuntimeStore.workingTool} statusDetail={$useRuntimeStore.workingDetail} reasoning={workingReasoning} />{/if}
        </div>

        <form class:pa-composer-drop-active={dropActive} class="pa-composer" onsubmit={(event) => { event.preventDefault(); void submit(); }} ondragover={(event) => { event.preventDefault(); dropActive = true; }} ondragleave={() => dropActive = false} ondrop={(event) => { event.preventDefault(); dropActive = false; void addFiles(Array.from(event.dataTransfer?.files ?? [])); }}>
          {#if attachments.length}<div class="pa-filmstrip" aria-label={t("assistant.attached_images", "Attached reference images")}>{#each attachments as attachment, index (attachment.id)}<div class="pa-filmstrip-item"><button type="button" class="pa-filmstrip-preview" onclick={() => lightbox = { attachments, index }} oncontextmenu={(event) => { event.preventDefault(); attachmentMenuId = attachment.id; }} aria-label={tf("assistant.preview_named", "Preview {name}", { name: attachment.name })}><img src={attachmentPreviewUrl(attachment)} alt={attachment.name} width="58" height="54" /><span class="pa-filmstrip-name">{attachment.name}</span></button><button type="button" class="pa-filmstrip-remove" onclick={() => void removeAttachment(attachment.id)} aria-label={tf("assistant.remove_named", "Remove {name}", { name: attachment.name })}><X size={12} /></button><button type="button" class="pa-filmstrip-more" onclick={() => attachmentMenuId = attachmentMenuId === attachment.id ? null : attachment.id} aria-label={tf("assistant.edit_named", "Edit {name}", { name: attachment.name })}>•••</button>{#if attachmentMenuId === attachment.id}<div class="pa-attachment-menu" role="menu"><button type="button" role="menuitem" onclick={() => { replacementId = attachment.id; replacementInput?.click(); attachmentMenuId = null; }}><Pencil size={13} /> {t("common.replace", "Replace")}</button><button type="button" role="menuitem" onclick={() => { void removeAttachment(attachment.id); attachmentMenuId = null; }}><Trash2 size={13} /> {t("common.remove", "Remove")}</button></div>{/if}</div>{/each}<button type="button" class="pa-filmstrip-add" onclick={() => fileInput?.click()} aria-label={t("assistant.attach_another", "Attach another image")}><Plus size={17} /></button></div>{/if}
           <textarea name="prompt-agent-message" autocomplete="off" bind:this={composerInput} bind:value={draft} rows="1" placeholder={t("assistant.input.placeholder", "Ask about or change the current prompt…")} aria-label={t("assistant.input.label", "Message Prompt Agent")} onfocus={() => composerFocused = true} onblur={() => composerFocused = false} oninput={(event) => resizeComposer(event.currentTarget)} onkeydown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if ($useChatStore.activeRequestId) stop(); else void submit(); } }}></textarea>
          <div class="pa-composer-bottom"><div class="pa-composer-tools"><button type="button" class="pa-composer-icon" onclick={() => fileInput?.click()} aria-label={t("assistant.attach", "Attach reference images")}><ImagePlus size={16} /></button></div>
              <div class="pa-composer-tools"><div class="pa-composer-picker-row" aria-label={t("assistant.model_controls", "Model controls")}><ModelPicker /><ReasoningPicker /></div>{#if $useChatStore.activeRequestId}<button type="button" class="pa-send-button pa-stop-button" onclick={stop} disabled={$useRuntimeStore.workingPhase === "cancelling"} aria-label={t("assistant.stop", "Stop response")}><CircleStop size={17} /></button>{:else}<button type="submit" class="pa-send-button" onpointerdown={keepComposerFocus} disabled={!draft.trim() && !attachments.length} aria-label={t("assistant.send", "Send message")}><Send size={17} /></button>{/if}</div>
           </div>
          <input bind:this={fileInput} type="file" accept="image/*" multiple hidden onchange={(event) => { void addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
          <input bind:this={replacementInput} type="file" accept="image/*" hidden onchange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void replaceAttachment(file); event.currentTarget.value = ""; }} />
        </form>
       </div>
        {#if !composerFocused}<button type="button" class="pa-resize-handle" data-prompt-agent-interaction-handle="true" use:pointerWindow={{ mode: "resize", layout: () => currentLayout, update: updateLayout, minimum: windowMinimum, interacting: (active) => interacting = active }} onkeydown={resizeKey} aria-label={t("assistant.resize", "Resize chat window")}><Grip size={15} /></button>{/if}
    {#if kind !== "desktop" && !$useUiStore.hasSeenMobileResizeHint && !mobileHintDismissed}<div class="pa-mobile-resize-hint" role="status"><Grip size={14} /> {t("assistant.resize_hint", "Drag the corner to resize")}<button type="button" onclick={() => { mobileHintDismissed = true; $useUiStore.markMobileResizeHintSeen(); }}>{t("common.dismiss", "Dismiss")}</button></div>{/if}
    </div>
  {/if}

  <ProfileSettings open={$useUiStore.profileSettingsOpen} onclose={closeSettings} />

  {#if lightbox && lightbox.attachments[lightbox.index]}
    <div class="pa-lightbox" role="dialog" tabindex="-1" aria-modal="true" aria-label={t("lightbox.title", "Image preview")} onclick={() => lightbox = null} onkeydown={(event) => { if (event.key === "Escape") lightbox = null; }}>
      <div class="pa-lightbox-panel" onclick={(event) => event.stopPropagation()} role="presentation"><button type="button" class="pa-lightbox-close" onclick={() => lightbox = null} aria-label={t("lightbox.close", "Close preview")}><X size={18} /></button><img src={attachmentPreviewUrl(lightbox.attachments[lightbox.index])} alt={lightbox.attachments[lightbox.index].name} width="900" height="900" />{#if lightbox.attachments.length > 1}<button type="button" class="pa-lightbox-nav pa-lightbox-prev" disabled={lightbox.index === 0} onclick={() => lightbox && (lightbox = { ...lightbox, index: Math.max(0, lightbox.index - 1) })} aria-label={t("lightbox.previous", "Previous image")}><ChevronLeft size={22} /></button><button type="button" class="pa-lightbox-nav pa-lightbox-next" disabled={lightbox.index === lightbox.attachments.length - 1} onclick={() => lightbox && (lightbox = { ...lightbox, index: Math.min(lightbox.attachments.length - 1, lightbox.index + 1) })} aria-label={t("lightbox.next", "Next image")}><ChevronRight size={22} /></button><span class="pa-lightbox-count">{lightbox.index + 1} / {lightbox.attachments.length}</span>{/if}</div>
    </div>
  {/if}
</div>
