<script lang="ts">
  import { onMount } from "svelte";
  import { Check, ChevronDown, Clock3, GripVertical, Plus, Search, Sparkles, Star } from "lucide-svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import type { Profile } from "../contracts";
  import { floatingPopover } from "../floating-popover";
  import { supportsAgentChat } from "../providers/profile-capabilities";
  import { useI18nStore } from "../stores/i18n";
  import { useProfileStore } from "../stores/profiles";
  import { useUiStore } from "../stores/ui";
  import {
    LEGACY_STORAGE_KEYS,
    PROMPT_AGENT_STORAGE_KEYS,
    readMigratedStorageValue,
    writePromptAgentStorageValue,
  } from "../storage-migrations";

  const FAVORITES_KEY = PROMPT_AGENT_STORAGE_KEYS.modelPickerFavorites;
  const RECENTS_KEY = PROMPT_AGENT_STORAGE_KEYS.modelPickerRecents;

  let open = $state(false);
  let search = $state("");
  let anchor = $state<HTMLDivElement>();
  let popover = $state<HTMLDivElement>();
  let favoriteIds = $state<string[]>([]);
  let recentIds = $state<string[]>([]);

  const activeProfile = $derived($useProfileStore.profiles.find((profile) => profile.id === $useProfileStore.activeProfileId));
  const enabledProfiles = $derived($useProfileStore.profiles.filter((profile) => profile.enabled));
  const filteredProfiles = $derived(enabledProfiles.filter((profile) => matches(profile, search)));
  const favoriteProfiles = $derived(filteredProfiles.filter((profile) => favoriteIds.includes(profile.id)));
  const recentProfiles = $derived(filteredProfiles.filter((profile) => recentIds.includes(profile.id) && !favoriteIds.includes(profile.id)));
  const providerGroups = $derived.by(() => {
    const groups = new Map<string, Profile[]>();
    for (const profile of filteredProfiles.filter((item) => !favoriteIds.includes(item.id) && !recentIds.includes(item.id))) {
      const provider = providerLabel(profile);
      groups.set(provider, [...(groups.get(provider) ?? []), profile]);
    }
    return [...groups.entries()];
  });

  function t(key: string, fallback: string): string {
    const translated = $useI18nStore.t(key);
    return translated === key ? fallback : translated;
  }

  function tf(key: string, fallback: string, values: Record<string, string | number>): string {
    return Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      t(key, fallback),
    );
  }

  function matches(profile: Profile, query: string): boolean {
    const normalized = query.trim().toLowerCase();
    return !normalized || `${profile.displayName} ${profile.modelId} ${providerLabel(profile)}`.toLowerCase().includes(normalized);
  }

  function providerLabel(profile: Profile): string {
    if (profile.modelInfo.providerId) return profile.modelInfo.providerId.toUpperCase();
    if (profile.runtime !== "remote-http") return "LOCAL";
    try {
      return new URL(profile.endpoint).hostname.split(".")[0]?.toUpperCase() || "CUSTOM";
    } catch {
      return "CUSTOM";
    }
  }

  function contextLabel(profile: Profile): string {
    const limit = profile.modelInfo.contextLimit;
    if (!limit) return profile.runtime === "remote-http" ? t("model_picker.remote", "Remote") : t("model_picker.local", "Local");
    if (limit >= 1_000_000) return `${(limit / 1_000_000).toFixed(1)}m ctx`;
    if (limit >= 1_000) return `${Math.round(limit / 1_000)}k ctx`;
    return `${limit} ctx`;
  }

  function reasoningLabel(profile: Profile): string {
    const value = profile.parameters.reasoningEffort;
    return value === "none" ? t("settings.reasoning_none", "Off") : t(`settings.reasoning_${value}`, value[0].toUpperCase() + value.slice(1));
  }

  function legacyKeyFor(key: string): string {
    return key === FAVORITES_KEY ? LEGACY_STORAGE_KEYS.modelPickerFavorites : LEGACY_STORAGE_KEYS.modelPickerRecents;
  }

  function readIds(key: string): string[] {
    try {
      const value = JSON.parse(readMigratedStorageValue(localStorage, key, legacyKeyFor(key)) ?? "[]");
      return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function saveIds(key: string, values: string[]): void {
    try { writePromptAgentStorageValue(localStorage, key, legacyKeyFor(key), JSON.stringify(values)); } catch { /* Storage can be unavailable in private contexts. */ }
  }

  function toggleFavorite(profileId: string): void {
    favoriteIds = favoriteIds.includes(profileId)
      ? favoriteIds.filter((id) => id !== profileId)
      : [...favoriteIds, profileId];
    saveIds(FAVORITES_KEY, favoriteIds);
  }

  function selectProfile(profileId: string): void {
    const profile = enabledProfiles.find((item) => item.id === profileId);
    if (!profile || !supportsAgentChat(profile)) return;
    $useProfileStore.activateProfile(profileId);
    recentIds = [profileId, ...recentIds.filter((id) => id !== profileId)].slice(0, 8);
    saveIds(RECENTS_KEY, recentIds);
    open = false;
    search = "";
  }

  function openProfiles(): void {
    open = false;
    $useUiStore.setProfileSettingsOpen(true);
    $useUiStore.bringToFront("profiles");
  }

  onMount(() => {
    const available = new Set(enabledProfiles.map((profile) => profile.id));
    favoriteIds = readIds(FAVORITES_KEY).filter((id) => available.has(id));
    recentIds = readIds(RECENTS_KEY).filter((id) => available.has(id));
    if (!favoriteIds.length && activeProfile) favoriteIds = [activeProfile.id];

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

<div class="pa-model-picker" bind:this={anchor}>
  <Button
    variant="ghost"
    class="pa-model-picker-trigger pa-h-8 pa-max-w-44 pa-rounded-md pa-px-1.5"
    aria-label={t("model_picker.active", "Active model")}
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={() => open = !open}
  >
    <Sparkles size={15} />
    <span>{activeProfile?.displayName ?? t("model_picker.select", "Select model")}</span>
    <ChevronDown size={13} aria-hidden="true" />
  </Button>
  <select class="pa-sr-only" tabindex="-1" aria-hidden="true" aria-label={t("model_picker.active", "Active model")} value={$useProfileStore.activeProfileId} onchange={(event) => selectProfile(event.currentTarget.value)}>
    {#each enabledProfiles as profile}<option value={profile.id}>{profile.displayName}</option>{/each}
  </select>

  {#if open}
    <div bind:this={popover} use:floatingPopover={() => anchor} class="pa-model-picker-popover" role="dialog" tabindex="-1" aria-label={t("model_picker.select", "Select model")}>
      <button type="button" class="pa-model-picker-add" onclick={openProfiles}><Plus size={15} /> {t("model_picker.add_provider", "Add provider")}</button>
      <label class="pa-model-picker-search">
        <Search size={16} aria-hidden="true" />
        <Input bind:value={search} placeholder={t("model_picker.search", "Search models")} aria-label={t("model_picker.search", "Search models")} />
      </label>

      {#if favoriteProfiles.length}
        <section class="pa-model-picker-section">
          <div class="pa-model-picker-section-heading"><span><Star size={15} /> {t("model_picker.favorites", "Favorites")}</span><ChevronDown size={14} aria-hidden="true" /></div>
          <div class="pa-model-picker-list" role="listbox" aria-label={t("model_picker.favorite_models", "Favorite models")}>
            {#each favoriteProfiles as profile (profile.id)}{@render modelRow(profile)}{/each}
          </div>
        </section>
      {/if}

      {#if recentProfiles.length}
        <section class="pa-model-picker-section">
          <div class="pa-model-picker-section-heading"><span><Clock3 size={15} /> {t("model_picker.recent", "Recent")}</span><ChevronDown size={14} aria-hidden="true" /></div>
          <div class="pa-model-picker-list" role="listbox" aria-label={t("model_picker.recent_models", "Recent models")}>
            {#each recentProfiles as profile (profile.id)}{@render modelRow(profile)}{/each}
          </div>
        </section>
      {/if}

      {#if providerGroups.length}
        {#each providerGroups as [provider, profiles] (provider)}
          <section class="pa-model-picker-section">
            <div class="pa-model-picker-section-heading"><span class="pa-model-picker-provider"><i>{provider.slice(0, 1)}</i>{provider}</span><ChevronDown size={14} aria-hidden="true" /></div>
            <div class="pa-model-picker-list" role="listbox" aria-label={tf("model_picker.provider_models", "{provider} models", { provider })}>
              {#each profiles as profile (profile.id)}{@render modelRow(profile)}{/each}
            </div>
          </section>
        {/each}
      {:else if !favoriteProfiles.length && !recentProfiles.length}
        <p class="pa-model-picker-empty">{t("model_picker.empty", "No models match this search.")}</p>
      {/if}
    </div>
  {/if}
</div>

{#snippet modelRow(profile: Profile)}
  <div class:is-active={profile.id === $useProfileStore.activeProfileId} class="pa-model-picker-row" role="option" aria-selected={profile.id === $useProfileStore.activeProfileId}>
    <button type="button" class="pa-model-picker-row-main" disabled={!supportsAgentChat(profile)} onclick={() => selectProfile(profile.id)}>
      <GripVertical size={14} class="pa-model-picker-grip" aria-hidden="true" />
      <Sparkles size={15} aria-hidden="true" />
      <span class="pa-model-picker-row-copy"><strong>{profile.displayName}</strong><small>{supportsAgentChat(profile) ? contextLabel(profile) : t("model_picker.agent_unavailable", "Agent chat unavailable")}</small></span>
      {#if profile.id === $useProfileStore.activeProfileId && profile.capabilities.reasoning}<span class="pa-model-picker-thinking">{t("model_picker.thinking", "Thinking")}: {reasoningLabel(profile)}</span>{/if}
    </button>
    <button type="button" class:is-favorite={favoriteIds.includes(profile.id)} class="pa-model-picker-star" aria-label={tf(favoriteIds.includes(profile.id) ? "model_picker.remove_favorite" : "model_picker.add_favorite", favoriteIds.includes(profile.id) ? "Remove {name} favorite" : "Add {name} favorite", { name: profile.displayName })} onclick={(event) => { event.stopPropagation(); toggleFavorite(profile.id); }}>
      {#if profile.id === $useProfileStore.activeProfileId}<Check size={15} class="pa-model-picker-check" aria-hidden="true" />{/if}
      <Star size={16} fill={favoriteIds.includes(profile.id) ? "currentColor" : "none"} aria-hidden="true" />
    </button>
  </div>
{/snippet}
