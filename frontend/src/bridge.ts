import { z } from "zod";

export const BRIDGE_API_VERSION = 1 as const;
export const BRIDGE_VERSION = "1.0.0" as const;
export const BRIDGE_NAME = "kohaku-loom-svelte-ui" as const;
export const HOST_API_NAME = "kohaku-loom-host" as const;
const bridgeCapabilities = [
  "forge-availability",
  "prompt-target",
  "forge-state",
  "tool-execution",
  "profile-store",
  "tool-bridge-lease",
  "assistant-config",
  "session-runtime",
  "legacy-sessions",
  "locale-hints",
] as const;
export type BridgeCapability = (typeof bridgeCapabilities)[number];
const coreCapabilities = ["profile-store", "tool-bridge-lease", "assistant-config", "session-runtime"] as const;

export const bridgeHandshakeRequestSchema = z.object({
  client: z.string().min(1),
  apiVersion: z.number().int().nonnegative(),
});

export interface BridgeHandshakeRequest {
  client: string;
  apiVersion: number;
}

export interface BridgeHandshakeAccepted {
  ok: true;
  bridge: typeof BRIDGE_NAME;
  apiVersion: typeof BRIDGE_API_VERSION;
  version: typeof BRIDGE_VERSION;
  capabilities: readonly BridgeCapability[];
}

export interface BridgeHandshakeRejected {
  ok: false;
  bridge: typeof BRIDGE_NAME;
  apiVersion: typeof BRIDGE_API_VERSION;
  reason: "client-mismatch" | "unsupported-api-version" | "host-unavailable";
}

export type BridgeHandshakeResponse = BridgeHandshakeAccepted | BridgeHandshakeRejected;

export interface KohakuLoomHostApi {
  readonly name: typeof HOST_API_NAME;
  readonly version: typeof BRIDGE_VERSION;
  readonly apiVersion: typeof BRIDGE_API_VERSION;
  readonly capabilities: readonly BridgeCapability[];
  handshake(request: BridgeHandshakeRequest): BridgeHandshakeResponse;
  isForgeAvailable(): boolean;
  activePromptTarget(): string;
  readPrompt(target?: string): Promise<unknown>;
  captureForgeState(): unknown;
  restoreForgeState(snapshot: unknown): boolean;
  executeTool(tool: unknown, signal?: AbortSignal): Promise<unknown>;
  executeAssistantTool(tool: unknown, signal?: AbortSignal): Promise<unknown>;
  assistantConfig(routeOverride?: string): unknown;
  profileStore: KohakuLoomProfileStoreFacade;
  claimToolBridge(): Promise<unknown>;
  releaseToolBridge(): Promise<unknown>;
  claimAssistantToolBridge(): Promise<unknown>;
  releaseAssistantToolBridge(): Promise<unknown>;
  syncProfiles(): Promise<unknown>;
  profileChat(profileId: string, messages: unknown[], signal?: AbortSignal, timeout?: number): Promise<unknown>;
  listLegacySessions(limit?: number): Promise<unknown>;
  getLegacySession(sessionId: string, limit?: number): Promise<unknown>;
  readonly ktBaseUrl?: string;
  getLocaleHints(): unknown;
  subscribeLocaleHints(listener: (hints: unknown) => void): () => void;
  openSettings(): unknown;
}

export type KohakuLoomBridgeApi = KohakuLoomHostApi;

export interface KohakuLoomProfileStoreFacade {
  load(): unknown;
  current(): unknown;
  teacher(): unknown;
  session(): unknown;
  add(profile: unknown): unknown;
  duplicate(id: string): unknown;
  update(id: string, patch: unknown): unknown;
  delete(id: string): unknown;
  setActive(id: string): unknown;
  setTeacher(id: string): unknown;
  setSession(id: string): unknown;
  setNaming(id: string): unknown;
  restoreDefaults(): unknown;
  requestProjection(id?: string): unknown;
}

export interface KohakuLoomNamespace {
  hostApi?: unknown;
  svelteUiBridge?: unknown;
  forgeLocale?: unknown;
  loomForgeLocale?: unknown;
  loomActiveLocale?: unknown;
  [key: string]: unknown;
}

const capabilities = bridgeCapabilities;
const facadeCache = new WeakMap<object, KohakuLoomHostApi>();

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function assertFunction(value: unknown, name: string): void {
  if (typeof value !== "function") throw new Error(`Kohaku Loom host API missing ${name}`);
}

export function validateHostApi(value: unknown): KohakuLoomHostApi {
  if (!isObject(value)) throw new Error("Kohaku Loom host API is unavailable");
  if (value.name !== HOST_API_NAME || value.apiVersion !== BRIDGE_API_VERSION || value.version !== BRIDGE_VERSION) {
    throw new Error("Kohaku Loom host API version is unsupported");
  }
  const hostCapabilities = value.capabilities;
  if (!Array.isArray(hostCapabilities) || !coreCapabilities.every((item) => hostCapabilities.includes(item))) {
    throw new Error("Kohaku Loom host API core capabilities are incomplete");
  }
  const profileStore = value.profileStore;
  [
    "handshake",
    "captureForgeState",
    "restoreForgeState",
    "executeAssistantTool",
    "assistantConfig",
    "claimToolBridge",
    "releaseToolBridge",
    "syncProfiles",
    "openSettings",
  ].forEach((name) => assertFunction(value[name], name));
  if (!isObject(profileStore)) throw new Error("Kohaku Loom host API profile store is unavailable");
  [
    "load",
    "current",
    "teacher",
    "session",
    "add",
    "duplicate",
    "update",
    "delete",
    "setActive",
    "setTeacher",
    "setSession",
    "setNaming",
    "restoreDefaults",
    "requestProjection",
  ].forEach((name) => assertFunction((profileStore as Record<string, unknown>)?.[name], `profileStore.${name}`));
  return value as unknown as KohakuLoomHostApi;
}

function createBridgeFacade(host: KohakuLoomHostApi): KohakuLoomHostApi {
  const cached = facadeCache.get(host);
  if (cached) return cached;
  const value = host as unknown as Record<string, unknown>;
  const bind = <T extends (...args: any[]) => any>(name: string, fallback: T): T => (
    typeof value[name] === "function" ? (value[name] as T).bind(host) as T : fallback
  );
  const executeAssistantTool = bind("executeAssistantTool", async () => {
    throw new Error("Forge tool execution is unavailable");
  });
  const facade: KohakuLoomHostApi = {
    ...host,
    isForgeAvailable: bind("isForgeAvailable", () => true),
    activePromptTarget: bind("activePromptTarget", () => "active"),
    readPrompt: bind("readPrompt", async () => { throw new Error("Forge prompt reading is unavailable"); }),
    executeAssistantTool,
    executeTool: bind("executeTool", executeAssistantTool),
    claimAssistantToolBridge: bind("claimAssistantToolBridge", host.claimToolBridge.bind(host)),
    releaseAssistantToolBridge: bind("releaseAssistantToolBridge", host.releaseToolBridge.bind(host)),
    profileChat: bind("profileChat", async () => { throw new Error("Profile connection testing is unavailable"); }),
    listLegacySessions: bind("listLegacySessions", async () => ({ sessions: [] })),
    getLegacySession: bind("getLegacySession", async () => { throw new Error("Legacy session archive is unavailable"); }),
    getLocaleHints: bind("getLocaleHints", () => ({ locale: typeof navigator === "undefined" ? "en" : navigator.language || "en" })),
    subscribeLocaleHints: bind("subscribeLocaleHints", () => () => undefined),
    handshake(request) {
      const parsed = bridgeHandshakeRequestSchema.safeParse(request);
      if (!parsed.success || parsed.data.client !== BRIDGE_NAME) {
        return {
          ok: false,
          bridge: BRIDGE_NAME,
          apiVersion: BRIDGE_API_VERSION,
          reason: "client-mismatch",
        };
      }
      if (parsed.data.apiVersion !== BRIDGE_API_VERSION) {
        return {
          ok: false,
          bridge: BRIDGE_NAME,
          apiVersion: BRIDGE_API_VERSION,
          reason: "unsupported-api-version",
        };
      }
      return host.handshake(parsed.data);
    },
  };
  facadeCache.set(host, facade);
  return facade;
}

export function getHostApi(namespace: KohakuLoomNamespace | undefined): KohakuLoomHostApi | null {
  try {
    return createBridgeFacade(validateHostApi(namespace?.hostApi));
  } catch (_error) {
    return null;
  }
}

export interface WaitForHostOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

function wait(delay: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForHostApi(
  namespace: () => KohakuLoomNamespace | undefined,
  options: WaitForHostOptions = {},
): Promise<KohakuLoomHostApi> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return createBridgeFacade(validateHostApi(namespace()?.hostApi));
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs, options.signal);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Kohaku Loom host API did not become ready${detail}`);
}

// Kept as a compatibility name; it validates the host and never installs a bridge.
export function installBridge(namespace: KohakuLoomNamespace): KohakuLoomHostApi {
  return createBridgeFacade(validateHostApi(namespace.hostApi));
}

export function createBridgeApi(value?: unknown): KohakuLoomHostApi {
  return createBridgeFacade(validateHostApi(value));
}

export function handshakeWithLoom(
  namespace: KohakuLoomNamespace,
  request: BridgeHandshakeRequest,
): BridgeHandshakeResponse {
  const host = getHostApi(namespace);
  if (!host) {
    return { ok: false, bridge: BRIDGE_NAME, apiVersion: BRIDGE_API_VERSION, reason: "host-unavailable" };
  }
  return host.handshake(request);
}

export { capabilities as BRIDGE_CAPABILITIES };
