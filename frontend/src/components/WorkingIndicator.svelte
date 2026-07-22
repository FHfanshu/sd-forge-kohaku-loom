<script lang="ts">
  import { BrainCircuit, ChevronRight, CircleStop, RefreshCw, Send, ServerCog, Sparkles, Wrench } from "lucide-svelte";
  import type { WorkingPhase } from "../stores/runtime";
  import { useI18nStore } from "../stores/i18n";

  let { phase, tool = null, statusDetail = null, reasoning = "" }: { phase: Exclude<WorkingPhase, "idle">; tool?: string | null; statusDetail?: string | null; reasoning?: string } = $props();

  function t(key: string, fallback: string): string {
    const value = $useI18nStore.t(key);
    return value === key ? fallback : value;
  }

  const label = $derived(phase === "model-loading"
    ? t("assistant.working.model_loading", "Loading local model…")
    : phase === "submitting"
    ? t("assistant.working.submitting", "Sending request…")
    : phase === "cancelling"
      ? t("assistant.working.cancelling", "Stopping response…")
      : phase === "retrying"
        ? statusDetail?.startsWith("Provider request")
          ? t("assistant.working.provider_retrying", "Retrying provider request…")
          : t("assistant.working.retrying", "Retrying with tool feedback…")
      : phase === "tool"
        ? t("assistant.working.tool", "Running tool…")
        : phase === "generating"
          ? t("assistant.working.generating", "Generating response…")
          : t("assistant.working.thinking", "Thinking…"));
  const reasoningExcerpt = $derived.by(() => {
    const text = reasoning.replace(/\s+/g, " ").trim();
    return text.length > 180 ? `…${text.slice(-180)}` : text;
  });
  const modelLoadDetail = $derived.by(() => {
    if (phase !== "model-loading" || !statusDetail) return "";
    const [status, seconds = "0"] = statusDetail.split(":");
    if (status === "ready") return t("assistant.working.model_ready", "Local model is ready");
    if (status === "failed") return t("assistant.working.model_failed", "Local model failed to load");
    return `${t("assistant.working.model_starting", "Starting llama.cpp and loading model weights")}${Number(seconds) > 0 ? ` · ${seconds}s` : ""}`;
  });
  const detail = $derived(phase === "model-loading"
    ? modelLoadDetail
    : phase === "retrying" && statusDetail
    ? statusDetail
    : phase === "tool" && tool
    ? `${t("assistant.working.tool_name", "Tool")}: ${tool}`
    : reasoningExcerpt
      ? `${t("assistant.working.reasoning", "Reasoning")}: ${reasoningExcerpt}`
      : "");
</script>

<details class:pa-working-has-reasoning={Boolean(reasoningExcerpt)} class="pa-working-indicator pa-working-{phase}" role="status" aria-live="polite">
  <summary><span class="pa-working-icon" aria-hidden="true">{#if phase === "model-loading"}<ServerCog size={14} />{:else if phase === "submitting"}<Send size={14} />{:else if phase === "cancelling"}<CircleStop size={14} />{:else if phase === "retrying"}<RefreshCw size={14} />{:else if phase === "tool"}<Wrench size={14} />{:else if phase === "generating"}<Sparkles size={14} />{:else}<BrainCircuit size={14} />{/if}</span><strong><span>{label}</span>{#if phase === "tool" && tool} <code>{tool}</code>{/if}</strong><span class="pa-working-thread" aria-hidden="true"><i></i></span><ChevronRight class="pa-working-chevron" size={14} aria-hidden="true" /></summary>
  {#if detail}<small class="pa-working-detail" title={detail}>{detail}</small>{/if}
</details>
