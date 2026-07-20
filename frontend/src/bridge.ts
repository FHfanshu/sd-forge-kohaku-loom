import { z } from "zod";

export const BRIDGE_API_VERSION = 1 as const;
export const BRIDGE_VERSION = "1.0.0" as const;
export const BRIDGE_NAME = "prompt-agent-ui" as const;
export const HOST_API_NAME = "prompt-agent-host" as const;
const bridgeCapabilities = [
  "forge-availability",
  "prompt-target",
  "forge-state",
  "tool-execution",
  "locale-hints",
] as const;
export type BridgeCapability = (typeof bridgeCapabilities)[number];
const coreCapabilities = ["forge-availability", "prompt-target", "tool-execution"] as const;

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

export interface PromptAgentHostApi {
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
  getLocaleHints(): unknown;
  subscribeLocaleHints(listener: (hints: unknown) => void): () => void;
  openSettings(): unknown;
}

export type PromptAgentBridgeApi = PromptAgentHostApi;

export interface PromptAgentNamespace {
  hostApi?: unknown;
  ui?: unknown;
  forgeLocale?: unknown;
  activeLocale?: unknown;
  [key: string]: unknown;
}

export type PromptAgentWindow = Window;

const capabilities = bridgeCapabilities;
const facadeCache = new WeakMap<object, PromptAgentHostApi>();

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function assertFunction(value: unknown, name: string): void {
  if (typeof value !== "function") throw new Error(`Prompt Agent host API missing ${name}`);
}

export function validateHostApi(value: unknown): PromptAgentHostApi {
  if (!isObject(value)) throw new Error("Prompt Agent host API is unavailable");
  if (value.name !== HOST_API_NAME || value.apiVersion !== BRIDGE_API_VERSION || value.version !== BRIDGE_VERSION) {
    throw new Error("Prompt Agent host API version is unsupported");
  }
  const hostCapabilities = value.capabilities;
  if (!Array.isArray(hostCapabilities) || !coreCapabilities.every((item) => hostCapabilities.includes(item))) {
    throw new Error("Prompt Agent host API core capabilities are incomplete");
  }
  [
    "handshake",
    "isForgeAvailable",
    "activePromptTarget",
    "captureForgeState",
    "restoreForgeState",
    "executeAssistantTool",
    "openSettings",
  ].forEach((name) => assertFunction(value[name], name));
  return value as unknown as PromptAgentHostApi;
}

function createBridgeFacade(host: PromptAgentHostApi): PromptAgentHostApi {
  const cached = facadeCache.get(host);
  if (cached) return cached;
  const value = host as unknown as Record<string, unknown>;
  const bind = <T extends (...args: any[]) => any>(name: string, fallback: T): T => (
    typeof value[name] === "function" ? (value[name] as T).bind(host) as T : fallback
  );
  const executeAssistantTool = bind("executeAssistantTool", async () => {
    throw new Error("Forge tool execution is unavailable");
  });
  const facade: PromptAgentHostApi = {
    ...host,
    isForgeAvailable: bind("isForgeAvailable", () => true),
    activePromptTarget: bind("activePromptTarget", () => "active"),
    readPrompt: bind("readPrompt", async () => { throw new Error("Forge prompt reading is unavailable"); }),
    executeAssistantTool,
    executeTool: bind("executeTool", executeAssistantTool),
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

export function getHostApi(namespace: PromptAgentNamespace | undefined): PromptAgentHostApi | null {
  try {
    return createBridgeFacade(validateHostApi(namespace?.hostApi));
  } catch (_error) {
    return null;
  }
}

export function promptAgentNamespace(globalWindow: PromptAgentWindow): PromptAgentNamespace | undefined {
  return globalWindow.__SD_FORGE_NEO_PROMPT_AGENT__;
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
  namespace: () => PromptAgentNamespace | undefined,
  options: WaitForHostOptions = {},
): Promise<PromptAgentHostApi> {
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
  throw new Error(`Prompt Agent host API did not become ready${detail}`);
}

export function installBridge(namespace: PromptAgentNamespace): PromptAgentHostApi {
  return createBridgeFacade(validateHostApi(namespace.hostApi));
}

export function createBridgeApi(value?: unknown): PromptAgentHostApi {
  return createBridgeFacade(validateHostApi(value));
}

export function handshakeWithPromptAgent(
  namespace: PromptAgentNamespace,
  request: BridgeHandshakeRequest,
): BridgeHandshakeResponse {
  const host = getHostApi(namespace);
  if (!host) {
    return { ok: false, bridge: BRIDGE_NAME, apiVersion: BRIDGE_API_VERSION, reason: "host-unavailable" };
  }
  return host.handshake(request);
}

export { capabilities as BRIDGE_CAPABILITIES };
