import { describe, expect, it, vi } from "vitest";
import { BRIDGE_API_VERSION, BRIDGE_NAME } from "../src/bridge";
import { installRuntimeContracts } from "../src/bootstrap";

describe("Svelte runtime bootstrap", () => {
  it("installs the Svelte contract before the host API exists", () => {
    delete window.__SD_FORGE_NEO_PROMPT_AGENT__;
    const ready = vi.fn();
    window.addEventListener("prompt-agent:svelte-ready", ready, { once: true });

    const api = installRuntimeContracts(window);

    expect(api.UI_READY).toBe(true);
    expect(api.bridge).toBeUndefined();
    expect(api.handshake({ client: BRIDGE_NAME, apiVersion: BRIDGE_API_VERSION })).toMatchObject({ ok: false, reason: "host-unavailable" });
    const namespace = window.__SD_FORGE_NEO_PROMPT_AGENT__ as { ui?: unknown } | undefined;
    expect(namespace && namespace.ui).toBe(api);
    expect(ready).toHaveBeenCalledOnce();
  });
});
