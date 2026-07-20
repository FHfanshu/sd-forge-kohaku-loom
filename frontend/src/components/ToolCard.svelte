<script lang="ts">
  import type { ChatMessage } from "../contracts";
  import { useI18nStore } from "../stores/i18n";
  import Markdown from "./Markdown.svelte";
  import { ChevronRight, Undo2 } from "lucide-svelte";

  let { message, onundo }: { message: ChatMessage; onundo?: (message: ChatMessage) => void | Promise<void> } = $props();

  function t(key: string, fallback: string): string {
    const value = $useI18nStore.t(key);
    return value === key ? fallback : value;
  }

  const detail = $derived(message.tool?.detail ?? "");
  const content = $derived(message.content && message.content !== detail ? message.content : "");
</script>

<details class="pa-tool-card" data-prompt-agent-tool-result="true">
  <summary>
     <span class="pa-tool-title"><ChevronRight size={14} aria-hidden="true" /><strong>{message.tool?.name ?? t("chat.tool_call", "Tool call")}</strong></span>
     <span class:pa-tool-status-error={message.tool?.status === "error"} class="pa-tool-status">{t(`chat.tool_status.${message.tool?.status ?? "complete"}`, message.tool?.status ?? "complete")}</span>
  </summary>
   <div class="pa-tool-result">
    {#if detail}<p>{detail}</p>{/if}
    {#if content}<Markdown content={content} streaming={message.status === "streaming"} />{/if}
     {#if message.tool?.undoable && !message.tool.undone}<button type="button" class="pa-tool-undo" onclick={() => void onundo?.(message)}><Undo2 size={13} /> {t("chat.undo_change", "Undo change")}</button>{:else if message.tool?.undone}<span class="pa-tool-undone">{t("chat.change_undone", "Change undone")}</span>{/if}
  </div>
</details>
