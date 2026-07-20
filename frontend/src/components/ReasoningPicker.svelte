<script lang="ts">
  import { onMount } from "svelte";
  import { Brain, ChevronDown } from "lucide-svelte";
  import type { ReasoningEffort } from "../contracts";
  import { floatingPopover } from "../floating-popover";
  import { useI18nStore } from "../stores/i18n";
  import { useProfileStore } from "../stores/profiles";

  let open = $state(false);
  let anchor = $state<HTMLDivElement>();
  let popover = $state<HTMLDivElement>();

  const activeProfile = $derived($useProfileStore.profiles.find((profile) => profile.id === $useProfileStore.activeProfileId && profile.enabled));
  const supported = $derived(Boolean(activeProfile && activeProfile.capabilities.reasoning !== false));
  const levels = $derived.by((): ReasoningEffort[] => {
    const modelLevels = activeProfile?.modelInfo.reasoningEfforts
      .map((value) => value.toLowerCase())
      .filter(isReasoningEffort)
      .filter((value) => value !== "none") ?? [];
    return modelLevels.length
      ? modelLevels
      : activeProfile?.modelInfo.source === "models.dev" ? ["high"] : ["low", "medium", "high", "max"];
  });
  const canDisable = $derived.by(() => {
    const info = activeProfile?.modelInfo;
    return !info || info.source !== "models.dev" || info.reasoningToggle || info.reasoningEfforts.includes("none");
  });
  const options = $derived(canDisable ? ["none", ...levels] as ReasoningEffort[] : levels);
  const value = $derived.by(() => {
    const current = String(activeProfile?.parameters.reasoningEffort ?? "low").toLowerCase();
    return options.includes(current as ReasoningEffort) ? current as ReasoningEffort : options[0] ?? "none";
  });
  const index = $derived(Math.max(0, options.indexOf(value)));

  function t(key: string, fallback: string): string {
    const translated = $useI18nStore.t(key);
    return translated === key ? fallback : translated;
  }

  function isReasoningEffort(value: string): value is ReasoningEffort {
    return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
  }

  function label(value: ReasoningEffort): string {
    return value === "none" ? t("settings.reasoning_none", "None") : t(`settings.reasoning_${value}`, value[0].toUpperCase() + value.slice(1));
  }

  function choose(next: ReasoningEffort, close = true): void {
    if (!activeProfile || !supported) return;
    $useProfileStore.updateProfile(activeProfile.id, { parameters: { reasoningEffort: next } });
    if (close) open = false;
  }

  function chooseIndex(rawValue: string): void {
    const option = options[Math.round(Number(rawValue))];
    if (option) choose(option, false);
  }

  function togglePicker(): void {
    open = !open;
  }

  onMount(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchor && !anchor.contains(target) && !popover?.contains(target)) open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        open = false;
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
    };
  });
</script>

<div class="pa-reasoning-picker" bind:this={anchor}>
  <button type="button" class="pa-reasoning-picker-trigger" disabled={!supported} aria-label={t("reasoning_picker.change", "Change reasoning effort")} aria-haspopup="dialog" aria-expanded={open} onclick={togglePicker}>
    <Brain size={15} aria-hidden="true" />
    <span>{label(value)}</span>
    <ChevronDown size={13} aria-hidden="true" />
  </button>

  {#if open}
    <div bind:this={popover} use:floatingPopover={() => anchor} class="pa-reasoning-picker-popover" role="dialog" tabindex="-1" aria-label={t("profiles.reasoning_effort", "Reasoning effort")}>
      <div class="pa-reasoning-picker-heading"><strong>{t("profiles.reasoning_effort", "Reasoning effort")}</strong><span>{label(value)}</span></div>
      <div class="pa-reasoning-picker-slider" style={`--pa-reasoning-progress: ${options.length > 1 ? index / (options.length - 1) * 100 : 0}%`}>
        <div class="pa-reasoning-picker-rail" aria-hidden="true"><span></span></div>
        <div class="pa-reasoning-picker-ticks" aria-hidden="true">
          {#each options as option (option)}<i class:is-active={option === value}></i>{/each}
        </div>
        <input type="range" min="0" max={Math.max(0, options.length - 1)} step="1" value={index} aria-label={t("profiles.reasoning_effort", "Reasoning effort")} oninput={(event) => chooseIndex(event.currentTarget.value)} />
      </div>
      <div class="pa-reasoning-picker-labels" aria-hidden="true">
        {#each options as option (option)}<span class:is-active={option === value}>{label(option)}</span>{/each}
      </div>
    </div>
  {/if}
</div>
