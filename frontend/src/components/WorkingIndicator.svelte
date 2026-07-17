<script lang="ts">
  import { BrainCircuit, Sparkles, Wrench } from "lucide-svelte";
  import type { WorkingPhase } from "../stores/runtime";
  import { useI18nStore } from "../stores/i18n";

  let { phase, tool = null }: { phase: Exclude<WorkingPhase, "idle">; tool?: string | null } = $props();

  function t(key: string, fallback: string): string {
    const value = $useI18nStore.t(key);
    return value === key ? fallback : value;
  }

  const label = $derived(phase === "tool"
    ? t("assistant.working.tool", "Running tool…")
    : phase === "generating"
      ? t("assistant.working.generating", "Generating response…")
      : t("assistant.working.thinking", "Thinking…"));
</script>

<div class="kl-working-indicator kl-working-{phase}" role="status" aria-live="polite">
  <span class="kl-working-icon" aria-hidden="true">
    {#if phase === "tool"}<Wrench size={15} />{:else if phase === "generating"}<Sparkles size={15} />{:else}<BrainCircuit size={15} />{/if}
  </span>
  <span class="kl-working-copy"><strong>{label}</strong>{#if phase === "tool" && tool}<small>{tool}</small>{/if}</span>
  <span class="kl-working-thread" aria-hidden="true"><i></i></span>
</div>
