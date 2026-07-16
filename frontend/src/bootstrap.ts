import { mount, unmount } from "svelte";
import type { BridgeHandshakeRequest, BridgeHandshakeResponse, KohakuLoomBridgeApi } from "./bridge";
import { validateHostApi } from "./bridge";
import Shell from "./components/Shell.svelte";
import { useUiStore } from "./stores/ui";

export const UI_READY = true as const;
let app: ReturnType<typeof mount> | null = null;

export function mountSvelteUi(host: HTMLElement = document.body): ReturnType<typeof mount> | null {
  if ((!UI_READY && !import.meta.env.DEV) || app) return app;
  const target = document.createElement("div");
  target.id = "kohaku-loom-svelte-mount";
  host.appendChild(target);
  app = mount(Shell, { target });
  return app;
}

export async function unmountSvelteUi(): Promise<void> {
  if (!app) return;
  await unmount(app);
  app = null;
  document.querySelector("#kohaku-loom-svelte-mount")?.remove();
}

export function openProfileSettings(): void {
  useUiStore.getState().setProfileSettingsOpen(true);
  useUiStore.getState().bringToFront("profiles");
}

export function closeProfileSettings(): void {
  useUiStore.getState().setProfileSettingsOpen(false);
}

export interface SvelteUiGlobal {
  UI_READY: typeof UI_READY;
  mountSvelteUi: typeof mountSvelteUi;
  unmountSvelteUi: typeof unmountSvelteUi;
  openProfileSettings: typeof openProfileSettings;
  closeProfileSettings: typeof closeProfileSettings;
  bridge?: KohakuLoomBridgeApi;
  handshake?(request: BridgeHandshakeRequest): BridgeHandshakeResponse;
  error?: string;
}

export function installRuntimeContracts(globalWindow: Window): SvelteUiGlobal | null {
  try {
    const bridge = validateHostApi(globalWindow.kohakuLoom?.hostApi);
    const api: SvelteUiGlobal = { UI_READY, mountSvelteUi, unmountSvelteUi, openProfileSettings, closeProfileSettings, bridge, handshake: (request) => bridge.handshake(request) };
    globalWindow.KohakuLoomSvelteUi = api;
    return api;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalWindow.KohakuLoomSvelteUi = { UI_READY, mountSvelteUi, unmountSvelteUi, openProfileSettings, closeProfileSettings, error: message };
    console.error(`[Kohaku Loom] Svelte UI host contract unavailable: ${message}`);
    return null;
  }
}
