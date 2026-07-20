import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_API_VERSION,
  BRIDGE_CAPABILITIES,
  BRIDGE_NAME,
  HOST_API_NAME,
  handshakeWithPromptAgent,
  installBridge,
  validateHostApi,
  waitForHostApi,
} from "../src/bridge";

function hostApi() {
  return {
    name: HOST_API_NAME,
    version: "1.0.0",
    apiVersion: BRIDGE_API_VERSION,
    capabilities: [...BRIDGE_CAPABILITIES],
    handshake: vi.fn((request: { client: string; apiVersion: number }) => ({
      ok: true as const,
      bridge: BRIDGE_NAME,
      apiVersion: BRIDGE_API_VERSION,
      version: "1.0.0" as const,
      capabilities: BRIDGE_CAPABILITIES,
      request,
    })),
    isForgeAvailable: vi.fn(),
    activePromptTarget: vi.fn(),
    readPrompt: vi.fn(),
    captureForgeState: vi.fn(),
    restoreForgeState: vi.fn(),
    executeTool: vi.fn(),
    executeAssistantTool: vi.fn(),
    openSettings: vi.fn(),
    getLocaleHints: vi.fn(),
    subscribeLocaleHints: vi.fn(),
  };
}

describe("Prompt Agent bridge handshake", () => {
  afterEach(() => vi.useRealTimers());
  it("accepts the host-owned API without replacing legacy keys", () => {
    const legacy = vi.fn();
    const host = hostApi();
    const namespace = { hostApi: host, legacy, existing: "preserved" };
    const bridge = installBridge(namespace);
    const result = bridge.handshake({ client: BRIDGE_NAME, apiVersion: BRIDGE_API_VERSION });

    expect(result).toMatchObject({ ok: true, bridge: BRIDGE_NAME, apiVersion: 1, version: "1.0.0" });
    expect(namespace.legacy).toBe(legacy);
    expect(namespace.existing).toBe("preserved");
    expect(namespace).not.toHaveProperty("svelteUiBridge");
    expect(installBridge(namespace)).toBe(bridge);
  });

  it("rejects a missing or incompatible host instead of installing a fake bridge", () => {
    expect(() => installBridge({})).toThrow(/host API/);
    expect(handshakeWithPromptAgent({}, { client: BRIDGE_NAME, apiVersion: BRIDGE_API_VERSION })).toMatchObject({
      ok: false,
      reason: "host-unavailable",
    });
    expect(() => validateHostApi({ ...hostApi(), apiVersion: 99 })).toThrow(/version/);
  });

  it("rejects mismatched clients and API versions through the host handshake", () => {
    const bridge = installBridge({ hostApi: hostApi() });
    expect(bridge.handshake({ client: "other-ui" as typeof BRIDGE_NAME, apiVersion: 1 })).toMatchObject({
      ok: false,
      reason: "client-mismatch",
    });
    expect(bridge.handshake({ client: BRIDGE_NAME, apiVersion: 99 })).toMatchObject({
      ok: false,
      reason: "unsupported-api-version",
    });
  });

  it("waits for a host API that registers after the Svelte bundle", async () => {
    vi.useFakeTimers();
    const namespace: { hostApi?: unknown } = {};
    const waiting = waitForHostApi(() => namespace, { timeoutMs: 1_000, intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(500);
    namespace.hostApi = hostApi();
    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toMatchObject({ name: HOST_API_NAME });
  });

  it("degrades locale hints without disabling the core host", () => {
    const host = hostApi();
    host.capabilities = host.capabilities.filter((item) => item !== "locale-hints");
    delete (host as Partial<typeof host>).getLocaleHints;
    delete (host as Partial<typeof host>).subscribeLocaleHints;

    const bridge = installBridge({ hostApi: host });

    expect(bridge.getLocaleHints()).toMatchObject({ locale: expect.any(String) });
    expect(bridge.subscribeLocaleHints(() => undefined)()).toBeUndefined();
  });
});
