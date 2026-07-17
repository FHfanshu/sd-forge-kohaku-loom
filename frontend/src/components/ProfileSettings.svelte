<script lang="ts">
  import { onMount } from "svelte";
  import { Activity, Brain, Check, Copy, ExternalLink, Grip, KeyRound, Languages, MoreHorizontal, Plus, RefreshCw, RotateCcw, ServerCog, Trash2, X } from "lucide-svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { NativeSelect } from "$lib/components/ui/native-select";
  import { Textarea } from "$lib/components/ui/textarea";
  import { AlertDialog } from "$lib/components/ui/alert-dialog";
  import { DropdownMenu } from "$lib/components/ui/dropdown-menu";
  import { Tabs } from "$lib/components/ui/tabs";
  import type { ProfilePatch, ProfileProtocol, ProfileRuntime } from "../contracts";
  import { getHostApi } from "../bridge";
  import { syncProfileFromModelsDev } from "../profile-model-catalog";
  import { useI18nStore } from "../stores/i18n";
  import { useProfileStore } from "../stores/profiles";
  import { useUiStore } from "../stores/ui";
  import { clampWindowLayout, pointerWindow, readViewportRect, viewportKind, type LayoutViewport } from "../window-interactions";
  import Field from "./settings/Field.svelte";
  import Route from "./settings/RouteField.svelte";
  import Heading from "./settings/SectionHeading.svelte";
  import Toggle from "./settings/ToggleField.svelte";

  let { open, onclose }: { open: boolean; onclose(): void } = $props();
  let tab = $state("model");
  let showKey = $state(false);
  let status = $state("");
  let busy = $state<"test" | "sync" | null>(null);
  let confirm = $state<"delete" | "restore" | null>(null);
  let interacting = $state(false);
  let windowElement = $state<HTMLDivElement>();
  let kind = $state<LayoutViewport>(viewportKind());
  let viewport = $state(readViewportRect());
  const minimum = { width: 340, height: 420 };
  const selected = $derived($useProfileStore.profiles.find((profile) => profile.id === $useProfileStore.selectedProfileId) ?? $useProfileStore.profiles[0]);
  const layout = $derived(clampWindowLayout($useUiStore.profileLayouts[kind], viewport, minimum));
  const enabledProfiles = $derived($useProfileStore.profiles.filter((profile) => profile.enabled));
  const localProfiles = $derived(enabledProfiles.filter((profile) => profile.runtime !== "remote-http"));
  const namingProfiles = $derived(enabledProfiles.filter((profile) => profile.runtime === "llama-once"));
  const profileTabs = $derived.by(() => [
    ["model", t("profiles.tab.model", "Model")],
    ...(selected.runtime !== "llama-once" ? [["connection", t("profiles.tab.connection", "Connection")]] : []),
    ["generation", t("profiles.tab.generation", "Generation")],
    ...(selected.runtime !== "remote-http" ? [["local", t("profiles.tab.local", "Local")]] : []),
    ["routes", t("profiles.tab.routes", "Routes")],
  ]);
  const reasoningScale = $derived.by(() => {
    if (!selected.capabilities.reasoning) return ["none"];
    const configured = selected.modelInfo.reasoningEfforts.map((value) => value.toLowerCase());
    const fallback = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    const values = selected.modelInfo.source === "models.dev"
      ? configured.length ? configured : ["high"]
      : fallback;
    if (selected.modelInfo.reasoningToggle && !values.includes("none")) values.unshift("none");
    return Array.from(new Set(values));
  });
  const reasoningIndex = $derived(Math.max(0, reasoningScale.indexOf(selected.parameters.reasoningEffort.toLowerCase())));

  function t(key: string, fallback: string): string {
    const value = $useI18nStore.t(key);
    return value === key ? fallback : value;
  }
  function refresh(): void { kind = viewportKind(); viewport = readViewportRect(); }
  function updateLayout(next: typeof layout): void { $useUiStore.setProfileLayout(kind, next); if (kind !== "desktop") $useUiStore.markMobileResizeHintSeen(); }
  function update(patch: ProfilePatch): void {
    try { $useProfileStore.updateProfile(selected.id, patch); status = t("profiles.status.saved", "Saved"); }
    catch { status = t("profiles.status.invalid", "Check this value and try again."); }
  }
  function numberValue(value: string, fallback: number): number { const result = Number(value); return Number.isFinite(result) ? result : fallback; }
  function reasoningLabel(value: string): string {
    const key = value === "none" ? "settings.reasoning_none" : `settings.reasoning_${value}`;
    return t(key, value === "none" ? "Off" : value[0].toUpperCase() + value.slice(1));
  }
  function setReasoning(index: number): void {
    const effort = reasoningScale[Math.round(index)];
    if (effort) update({ parameters: { reasoningEffort: effort } });
  }
  function add(): void { $useProfileStore.addProfile({ displayName: t("profiles.new_name", "New model profile"), modelId: "model-id" }); tab = "model"; }
  function duplicate(id = selected.id): void { $useProfileStore.duplicateProfile(id); }
  function requestDelete(id: string): void { $useProfileStore.selectProfile(id); confirm = "delete"; }
  function activate(id: string): void { $useProfileStore.activateProfile(id); status = t("profiles.status.saved", "Saved"); }
  async function testConnection(): Promise<void> {
    busy = "test"; status = t("profiles.test.testing", "Testing connection…");
    try { const host = getHostApi(window.kohakuLoom); if (!host) throw new Error("Host unavailable"); await host.profileChat(selected.id, [{ role: "user", content: t("profiles.test.ping", "Ping. Reply with OK.") }]); status = t("profiles.test.success", "Connection successful."); }
    catch { status = t("profiles.test.error", "Connection failed. Check the model profile."); }
    finally { busy = null; }
  }
  async function syncModel(): Promise<void> {
    busy = "sync"; status = t("profiles.models_dev.loading", "Querying models.dev…");
    try { const result = await syncProfileFromModelsDev(selected); update(result); status = t("profiles.models_dev.success", "Updated model parameters from models.dev."); }
    catch { status = t("profiles.models_dev.error", "No exact model match found on models.dev."); }
    finally { busy = null; }
  }
  function selectLanguage(value: "auto" | "en" | "zh-CN"): void { $useI18nStore.setLocale(value === "auto" ? null : value); }
  function resizeKey(event: KeyboardEvent): void {
    const delta = event.shiftKey ? 40 : 10;
    const width = event.key === "ArrowRight" ? delta : event.key === "ArrowLeft" ? -delta : 0;
    const height = event.key === "ArrowDown" ? delta : event.key === "ArrowUp" ? -delta : 0;
    if (!width && !height) return;
    event.preventDefault();
    updateLayout(clampWindowLayout({ ...layout, width: layout.width + width, height: layout.height + height }, viewport, minimum));
  }
  onMount(() => {
    window.addEventListener("resize", refresh);
    return () => window.removeEventListener("resize", refresh);
  });
  $effect(() => {
    if (!profileTabs.some(([value]) => value === tab)) tab = "model";
  });
  $effect(() => {
    if (open) requestAnimationFrame(() => windowElement?.focus());
  });
</script>

{#if open && selected}
  <div bind:this={windowElement} class:kl-window-interacting={interacting} class="kl-profile-window" style:left="{layout.left}px" style:top="{layout.top}px" style:width="{layout.width}px" style:height="{layout.height}px" style:z-index={$useUiStore.frontWindow === "profiles" ? 1003 : 1001} role="dialog" tabindex="-1" aria-modal="false" aria-label={t("profiles.title", "Model profiles")} data-profile-window="true" onpointerdown={() => $useUiStore.bringToFront("profiles")} onkeydown={(event) => { if (event.key === "Escape") onclose(); }}>
    <header class="kl-profile-window-header" use:pointerWindow={{ mode: "drag", layout: () => layout, update: updateLayout, minimum, disabled: kind !== "desktop", interacting: (active) => interacting = active }}>
      <div class="kl-brand-lockup"><div><strong>{t("profiles.title", "Model profiles")}</strong></div></div>
      <div class="kl-profile-window-actions">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger aria-label={t("profiles.more", "More settings actions")} class="kl-header-icon"><MoreHorizontal size={16} /></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content class="kl-dropdown-content"><DropdownMenu.Item class="kl-dropdown-item" onclick={() => $useUiStore.resetWindowLayouts()}><RotateCcw size={13} />{t("profiles.interface.reset", "Reset window layouts")}</DropdownMenu.Item><DropdownMenu.Item class="kl-dropdown-item" onclick={() => window.open("https://github.com/Kohaku-Lab/KohakuTerrarium", "_blank", "noopener,noreferrer")}><ExternalLink size={13} />{t("profiles.powered_by", "Powered by KohakuTerrarium")}</DropdownMenu.Item><DropdownMenu.Item class="kl-dropdown-item kl-profile-danger-text" onclick={() => confirm = "restore"}><RotateCcw size={13} />{t("profiles.restore", "Restore defaults")}</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger aria-label={t("settings.locale", "Language")} class="kl-header-icon"><Languages size={16} /></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content class="kl-dropdown-content"><DropdownMenu.RadioGroup value={$useI18nStore.manualLocale ?? "auto"} onValueChange={(value) => selectLanguage(value as "auto" | "en" | "zh-CN")}><DropdownMenu.RadioItem value="auto" class="kl-dropdown-item">{t("settings.locale.auto", "Auto")} ({$useI18nStore.locale === "zh-CN" ? "简体中文" : "English"})</DropdownMenu.RadioItem><DropdownMenu.RadioItem value="zh-CN" class="kl-dropdown-item">简体中文</DropdownMenu.RadioItem><DropdownMenu.RadioItem value="en" class="kl-dropdown-item">English</DropdownMenu.RadioItem></DropdownMenu.RadioGroup></DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button type="button" class="kl-header-icon" onclick={onclose} aria-label={t("profiles.close", "Close")}><X size={17} /></button>
      </div>
    </header>

    <div class="kl-profile-window-body">
      <aside class="kl-profile-sidebar">
        <div class="kl-profile-sidebar-title"><div><span class="kl-eyebrow">{t("profiles.fleet", "Models")}</span><strong>{$useProfileStore.profiles.length}</strong></div><button type="button" class="kl-profile-add-icon" onclick={add} aria-label={t("profiles.add", "Add")}><Plus size={15} /></button></div>
        <div class="kl-profile-list" role="listbox" aria-label={t("profiles.list", "Model profiles")}>
          {#each $useProfileStore.profiles as profile (profile.id)}
            <div class:is-selected={profile.id === selected.id} class:is-disabled={!profile.enabled} class="kl-profile-list-item">
              <button type="button" role="option" aria-selected={profile.id === selected.id} class="kl-profile-list-select" onclick={() => $useProfileStore.selectProfile(profile.id)}>
                <span class:is-enabled={profile.enabled} class="kl-profile-status-dot"></span><span class="kl-profile-list-copy"><strong>{profile.displayName}</strong><small>{profile.modelId}</small></span>
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger class="kl-profile-row-menu" aria-label={`${profile.displayName} ${t("profiles.actions", "actions")}`}><MoreHorizontal size={14} /></DropdownMenu.Trigger>
                <DropdownMenu.Portal><DropdownMenu.Content class="kl-dropdown-content"><DropdownMenu.Item class="kl-dropdown-item" onclick={() => duplicate(profile.id)}><Copy size={13} />{t("profiles.duplicate", "Duplicate")}</DropdownMenu.Item><DropdownMenu.Item class="kl-dropdown-item kl-profile-danger-text" onclick={() => requestDelete(profile.id)}><Trash2 size={13} />{t("profiles.delete", "Delete")}</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          {/each}
        </div>
      </aside>

      <main class="kl-profile-editor">
        <section class="kl-profile-summary">
          <div class="kl-profile-summary-main"><div><div class="kl-profile-title-row"><h2>{selected.displayName}</h2>{#if selected.id === $useProfileStore.activeProfileId}<span class="kl-profile-current-badge"><Check size={12} />{t("profiles.current", "Current")}</span>{/if}</div><p>{selected.modelId} · {selected.runtime}</p></div><button type="button" class:is-enabled={selected.enabled} class="kl-profile-enabled-toggle" aria-label={t("profiles.toggle_availability", "Toggle model availability")} aria-pressed={selected.enabled} title={selected.enabled ? t("profiles.enabled", "Enabled") : t("profiles.disabled", "Disabled")} onclick={() => update({ enabled: !selected.enabled })}><span>{selected.enabled ? t("profiles.enabled", "Enabled") : t("profiles.disabled", "Disabled")}</span><span class="kl-profile-enabled-switch" aria-hidden="true"><span></span></span></button></div>
          {#if selected.runtime !== "remote-http"}<div class="kl-profile-connection-row"><div class="kl-profile-local-callout"><ServerCog size={15} /><div><strong>{t("profiles.quick.local", "Local model - no API key needed")}</strong><small>{selected.runtime === "llama-once" ? selected.modelPath || t("profiles.model_path.empty", "Model path not configured") : selected.endpoint}</small></div></div></div>{/if}
          <div class="kl-profile-summary-footer"><div class="kl-profile-summary-actions"><Button size="sm" onclick={() => void testConnection()} disabled={busy !== null || !selected.enabled}><Activity size={13} />{busy === "test" ? t("profiles.test.testing", "Testing…") : t("profiles.test", "Test")}</Button>{#if selected.id !== $useProfileStore.activeProfileId}<Button variant="outline" size="sm" onclick={() => activate(selected.id)} disabled={!selected.enabled}><Check size={13} />{t("profiles.use_model", "Use model")}</Button>{/if}<Button variant="outline" size="sm" onclick={() => void syncModel()} disabled={busy !== null}><RefreshCw size={13} />{busy === "sync" ? t("profiles.models_dev.loading", "Syncing…") : t("profiles.models_dev.sync", "Sync parameters")}</Button></div>{#if status}<div class="kl-profile-status" role="status">{status}</div>{/if}</div>
        </section>

        <Tabs.Root bind:value={tab} class="kl-profile-tabs"><Tabs.List class="kl-profile-tabs-list" aria-label={t("profiles.advanced_tabs", "Profile settings")}>{#each profileTabs as item}<Tabs.Trigger value={item[0]} class="kl-profile-tab">{t(`profiles.tab.${item[0]}`, item[1])}</Tabs.Trigger>{/each}</Tabs.List>
            <Tabs.Content value="model"><div class="kl-profile-tab-content"><Heading title={t("profiles.section.basic", "Basic information")} hint={t("profiles.section.basic.hint", "Set this model's identity, protocol, runtime, and availability.")} /><div class="kl-profile-grid"><Field label={t("profiles.display_name", "Display name")}><Input value={selected.displayName} oninput={(event) => update({ displayName: event.currentTarget.value })} /></Field><Field label={t("profiles.model_id", "Model ID")}><Input value={selected.modelId} oninput={(event) => update({ modelId: event.currentTarget.value })} /></Field><Field label={t("profiles.protocol", "API protocol")}><NativeSelect value={selected.protocol} onchange={(event) => update({ protocol: event.currentTarget.value as ProfileProtocol })}><option value="gemini-native">{t("profiles.protocol.gemini", "Gemini native")}</option><option value="openai-chat-completions">{t("profiles.protocol.openai", "OpenAI chat completions")}</option></NativeSelect></Field><Field label={t("profiles.runtime", "Runtime")}><NativeSelect value={selected.runtime} onchange={(event) => update({ runtime: event.currentTarget.value as ProfileRuntime })}><option value="remote-http">{t("profiles.runtime.remote", "Remote HTTP")}</option><option value="llama-endpoint">{t("profiles.runtime.endpoint", "llama.cpp endpoint")}</option><option value="llama-once">{t("profiles.runtime.once", "llama.cpp one-shot")}</option></NativeSelect></Field></div><div class="kl-profile-toggle-grid"><Toggle label={t("profiles.capability.tools", "Tool calling")} checked={selected.capabilities.tools} onchange={(value: boolean) => update({ capabilities: { tools: value } })} /><Toggle label={t("profiles.capability.vision", "Vision input")} checked={selected.capabilities.vision} onchange={(value: boolean) => update({ capabilities: { vision: value } })} /><Toggle label={t("profiles.capability.streaming", "Streaming")} checked={selected.capabilities.streaming} onchange={(value: boolean) => update({ capabilities: { streaming: value } })} /></div></div></Tabs.Content>
            <Tabs.Content value="connection"><div class="kl-profile-tab-content"><Heading title={t("profiles.section.connection", "Connection")} hint={t("profiles.section.connection.hint", "Configure endpoints and credentials.")} /><div class="kl-profile-grid">{#if selected.runtime === "remote-http"}<Field wide label={t("profiles.api_key", "API key")}><div class="kl-profile-key-row"><KeyRound size={14} /><input name="api-key" autocomplete="off" spellcheck="false" aria-label={t("profiles.api_key", "API key")} type={showKey ? "text" : "password"} value={selected.apiKey} placeholder={selected.hasApiKey && !selected.apiKey ? t("profiles.api_key.stored", "Stored securely") : t("profiles.api_key.placeholder", "Paste an API key…")} oninput={(event) => update({ apiKey: event.currentTarget.value, hasApiKey: Boolean(event.currentTarget.value) || selected.hasApiKey })} /><button type="button" onclick={() => showKey = !showKey}>{showKey ? t("profiles.api_key.hide", "Hide") : t("profiles.api_key.show", "Show")}</button></div></Field>{/if}<Field wide label={t("profiles.endpoint", "Endpoint")}><Input value={selected.endpoint} disabled={selected.runtime === "llama-once"} oninput={(event) => update({ endpoint: event.currentTarget.value })} /></Field><Field wide label={t("profiles.fallback_endpoints", "Fallback endpoints (one per line)")}><Textarea value={selected.fallbackEndpoints.join("\n")} oninput={(event) => update({ fallbackEndpoints: event.currentTarget.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) })} /></Field></div></div></Tabs.Content>
            <Tabs.Content value="generation"><div class="kl-profile-tab-content"><Heading title={t("profiles.section.generation", "Generation parameters")} hint={t("profiles.section.generation.hint", "Set sampling, reasoning, and privacy behavior.")} /><div class="kl-profile-grid"><Field label={`${t("profiles.temperature", "Temperature")} · ${selected.parameters.temperature.toFixed(2)}`}><input class="kl-profile-slider" type="range" min="0" max="2" step="0.05" value={selected.parameters.temperature} oninput={(event) => update({ parameters: { temperature: numberValue(event.currentTarget.value, selected.parameters.temperature) } })} /></Field><Field label={`${t("profiles.top_p", "Top P")} · ${selected.parameters.topP.toFixed(2)}`}><input class="kl-profile-slider" type="range" min="0" max="1" step="0.05" value={selected.parameters.topP} oninput={(event) => update({ parameters: { topP: numberValue(event.currentTarget.value, selected.parameters.topP) } })} /></Field><Field label={t("profiles.max_tokens", "Max tokens")}><Input type="number" value={selected.parameters.maxTokens} oninput={(event) => update({ parameters: { maxTokens: Math.round(numberValue(event.currentTarget.value, selected.parameters.maxTokens)) } })} /></Field><Field label={`${t("profiles.reasoning_effort", "Reasoning effort")} · ${reasoningLabel(selected.parameters.reasoningEffort)}`}><div class="kl-profile-reasoning-slider"><Brain size={15} /><input class="kl-profile-slider" type="range" min="0" max={Math.max(0, reasoningScale.length - 1)} step="1" value={reasoningIndex} disabled={!selected.capabilities.reasoning} aria-label={t("profiles.reasoning_effort", "Reasoning effort")} oninput={(event) => setReasoning(Number(event.currentTarget.value))} /></div></Field></div></div></Tabs.Content>
            <Tabs.Content value="local"><div class="kl-profile-tab-content"><Heading title={t("profiles.section.local", "Local runtime")} hint={t("profiles.section.local.hint", "Configure llama.cpp paths and hardware allocation.")} /><div class="kl-profile-grid"><Field wide label={t("profiles.model_path", "GGUF path")}><Input value={selected.modelPath} oninput={(event) => update({ modelPath: event.currentTarget.value })} /></Field><Field wide label={t("profiles.mmproj_path", "mmproj path")}><Input value={selected.mmprojPath} oninput={(event) => update({ mmprojPath: event.currentTarget.value })} /></Field><Field wide label={t("profiles.llama_server_path", "llama-server path")}><Input value={selected.llamaServerPath} oninput={(event) => update({ llamaServerPath: event.currentTarget.value })} /></Field><Field label={t("profiles.n_ctx", "Context size")}><Input type="number" value={selected.nCtx} oninput={(event) => update({ nCtx: Math.round(numberValue(event.currentTarget.value, selected.nCtx)) })} /></Field><Field label={t("profiles.n_gpu_layers", "GPU layers")}><Input type="number" value={selected.nGpuLayers} oninput={(event) => update({ nGpuLayers: Math.round(numberValue(event.currentTarget.value, selected.nGpuLayers)) })} /></Field></div><Toggle label={t("profiles.thinking", "Thinking")} checked={selected.thinking} onchange={(thinking: boolean) => update({ thinking })} /></div></Tabs.Content>
            <Tabs.Content value="routes"><div class="kl-profile-tab-content"><Heading title={t("profiles.routes.title", "Routing")} hint={t("profiles.routes.hint", "Choose which enabled profile handles each assistant role.")} /><div class="kl-profile-route-grid"><Route label={t("profiles.active_profile", "Active profile")} value={$useProfileStore.activeProfileId} profiles={enabledProfiles} onchange={(id: string) => $useProfileStore.activateProfile(id)} /><Route label={t("profiles.teacher_profile", "Teacher profile")} value={$useProfileStore.teacherProfileId} profiles={enabledProfiles} onchange={(id: string) => $useProfileStore.setTeacherProfile(id)} /><Route label={t("profiles.session_profile", "Session model")} value={$useProfileStore.sessionProfileId} profiles={localProfiles} onchange={(id: string) => $useProfileStore.setSessionProfile(id)} /><Route label={t("profiles.naming_profile", "Naming model")} value={$useProfileStore.namingProfileId} profiles={namingProfiles} onchange={(id: string) => $useProfileStore.setNamingProfile(id)} /></div></div></Tabs.Content>
        </Tabs.Root>
      </main>
    </div>
    {#if kind === "desktop"}<button type="button" class="kl-profile-resize-handle" data-loom-interaction-handle="true" use:pointerWindow={{ mode: "resize", layout: () => layout, update: updateLayout, minimum, interacting: (active) => interacting = active }} onkeydown={resizeKey} aria-label={t("profiles.resize", "Resize profile window")}><Grip size={15} /></button>{/if}

    <AlertDialog.Root open={confirm === "delete"} onOpenChange={(value) => { if (!value) confirm = null; }}><AlertDialog.Portal><AlertDialog.Overlay class="kl-dialog-layer" /><AlertDialog.Content class="kl-dialog-card"><header><AlertDialog.Title>{t("profiles.delete", "Delete")}</AlertDialog.Title></header><AlertDialog.Description class="kl-dialog-description">{t("profiles.delete.confirm", "Delete this model profile?")}</AlertDialog.Description><div class="kl-dialog-actions"><AlertDialog.Cancel class="kl-dialog-cancel">{t("common.cancel", "Cancel")}</AlertDialog.Cancel><AlertDialog.Action class="kl-dialog-confirm" onclick={() => { $useProfileStore.deleteProfile(selected.id); confirm = null; }}>{t("profiles.delete.confirm_action", "Delete profile")}</AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
    <AlertDialog.Root open={confirm === "restore"} onOpenChange={(value) => { if (!value) confirm = null; }}><AlertDialog.Portal><AlertDialog.Overlay class="kl-dialog-layer" /><AlertDialog.Content class="kl-dialog-card"><header><AlertDialog.Title>{t("profiles.restore", "Restore defaults")}</AlertDialog.Title></header><AlertDialog.Description class="kl-dialog-description">{t("profiles.restore.confirm", "Replace all profiles with the defaults?")}</AlertDialog.Description><div class="kl-dialog-actions"><AlertDialog.Cancel class="kl-dialog-cancel">{t("common.cancel", "Cancel")}</AlertDialog.Cancel><AlertDialog.Action class="kl-dialog-confirm" onclick={() => { $useProfileStore.restoreDefaults(); confirm = null; }}>{t("profiles.restore.confirm_action", "Restore defaults")}</AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
  </div>
{/if}
