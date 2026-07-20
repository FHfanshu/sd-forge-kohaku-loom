import { mount, unmount } from "svelte";
import { getHostApi, handshakeWithPromptAgent, promptAgentNamespace, type BridgeHandshakeRequest, type PromptAgentBridgeApi, type PromptAgentWindow } from "./bridge";
import Shell from "./components/Shell.svelte";
import { useUiStore } from "./stores/ui";

export const UI_READY = true as const;
let app: ReturnType<typeof mount> | null = null;
let mountTarget: HTMLElement | null = null;

export function mountSvelteUi(host: HTMLElement = document.body): ReturnType<typeof mount> | null {
  if (app) return app;
  const existing = document.querySelector<HTMLElement>("#prompt-agent-svelte-mount");
  mountTarget = existing ?? document.createElement("div");
  mountTarget.id = "prompt-agent-svelte-mount";
  if (!mountTarget.isConnected) host.appendChild(mountTarget);
  app = mount(Shell, { target: mountTarget });
  return app;
}

export async function unmountSvelteUi(): Promise<void> {
  if (app) {
    await unmount(app);
    app = null;
  }
  mountTarget?.remove();
  mountTarget = null;
}

export function openProfileSettings(): void {
  useUiStore.getState().setProfileSettingsOpen(true);
  useUiStore.getState().bringToFront("profiles");
}

export function closeProfileSettings(): void {
  useUiStore.getState().setProfileSettingsOpen(false);
}

export interface SvelteUiGlobal {
  readonly UI_READY: typeof UI_READY;
  readonly bridge?: PromptAgentBridgeApi;
  mountSvelteUi: typeof mountSvelteUi;
  unmountSvelteUi: typeof unmountSvelteUi;
  openProfileSettings: typeof openProfileSettings;
  closeProfileSettings: typeof closeProfileSettings;
  handshake(request: BridgeHandshakeRequest): ReturnType<typeof handshakeWithPromptAgent>;
  error?: string;
}

export function installRuntimeContracts(globalWindow: Window): SvelteUiGlobal {
  const promptAgentWindow = globalWindow as PromptAgentWindow;
  const namespace = promptAgentNamespace(promptAgentWindow) ?? {};
  promptAgentWindow.__SD_FORGE_NEO_PROMPT_AGENT__ = namespace;
  const api: SvelteUiGlobal = {
    UI_READY,
    get bridge() {
      return getHostApi(promptAgentNamespace(promptAgentWindow)) ?? undefined;
    },
    mountSvelteUi,
    unmountSvelteUi,
    openProfileSettings,
    closeProfileSettings,
    handshake(request) {
      return handshakeWithPromptAgent(promptAgentNamespace(promptAgentWindow) ?? {}, request);
    },
  };
  namespace.ui = api;
  globalWindow.dispatchEvent(new CustomEvent("prompt-agent:svelte-ready"));
  return api;
}
