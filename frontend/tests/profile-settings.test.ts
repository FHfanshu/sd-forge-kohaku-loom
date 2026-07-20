import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProfileSettings from "../src/components/ProfileSettings.svelte";
import { normalizeProfile } from "../src/profile-adapter";
import { useI18nStore } from "../src/stores/i18n";
import { useProfileStore } from "../src/stores/profiles";
import { useUiStore } from "../src/stores/ui";

beforeEach(() => {
  document.body.removeAttribute("style");
  useProfileStore.getState().reset();
  useUiStore.getState().reset();
  useI18nStore.getState().clearManualLocale();
  useI18nStore.getState().reset();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  installProfileApi();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function installProfileApi(options: {
  connection?: (signal?: AbortSignal) => Promise<Record<string, unknown>>;
  failSecretSaves?: number;
  forceHasApiKey?: boolean;
} = {}): ReturnType<typeof vi.fn> {
  let failSecretSaves = options.failSecretSaves ?? 0;
  const storedKeys = new Set<string>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const profileId = decodeURIComponent(url.pathname.match(/\/profiles\/([^/]+)/)?.[1] ?? "");
    const current = useProfileStore.getState();
    const profile = current.profiles.find((item) => item.id === profileId) ?? current.profiles[0];
    if (url.pathname.endsWith("/connection-test")) {
      const result = await (options.connection?.(init?.signal ?? undefined) ?? Promise.resolve({ ok: true, transport: "system/environment proxy http://127.0.0.1:7890" }));
      return new Response(JSON.stringify(result), { status: 200 });
    }
    if (url.pathname === "/prompt-agent/api/profiles" && method === "GET") {
      return new Response(JSON.stringify(current), { status: 200 });
    }
    if (url.pathname === "/prompt-agent/api/profiles/restore-defaults" && method === "POST") {
      return new Response(JSON.stringify(current), { status: 200 });
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if ("api_key" in body) {
        if (failSecretSaves > 0) {
          failSecretSaves -= 1;
          return new Response(JSON.stringify({ detail: "unavailable" }), { status: 503 });
        }
        if (body.api_key) storedKeys.add(profileId); else storedKeys.delete(profileId);
      }
      const hasApiKey = options.forceHasApiKey ?? (storedKeys.has(profileId) || profile.hasApiKey);
      return new Response(JSON.stringify({ ...normalizeProfile(profile), hasApiKey, has_api_key: hasApiKey }), { status: 200 });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify(profile), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Svelte profile settings", () => {
  it("shows the flat model summary and direct settings tabs", () => {
    render(ProfileSettings, { open: true, onclose: () => undefined });
    expect(screen.getByRole("dialog", { name: "Model profiles" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument();
    ["Model", "Connection", "Generation", "Routes"].forEach((name) => expect(screen.getByRole("tab", { name })).toBeInTheDocument());
    expect(screen.queryByRole("tab", { name: "Local" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Interface" })).not.toBeInTheDocument();
  });

  it("keeps touch tablets in a floating, resizable profile window", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 820 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1180 });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });

    render(ProfileSettings, { open: true, onclose: () => undefined });

    const dialog = screen.getByRole("dialog", { name: "Model profiles" });
    expect(dialog).toHaveStyle({ width: "700px", height: "600px" });
    expect(screen.getByRole("button", { name: "Resize profile window" })).toBeInTheDocument();
  });

  it("keeps narrow phones full-screen without a resize handle", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });

    render(ProfileSettings, { open: true, onclose: () => undefined });

    const dialog = screen.getByRole("dialog", { name: "Model profiles" });
    expect(dialog).toHaveStyle({ left: "0px", top: "0px", width: "390px", height: "844px" });
    expect(screen.queryByRole("button", { name: "Resize profile window" })).not.toBeInTheDocument();
  });

  it("reports the resolved connection route and forwards a bounded timeout", async () => {
    const fetchMock = installProfileApi();
    render(ProfileSettings, { open: true, onclose: () => undefined });

    await fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Connection successful"));
    expect(screen.getByRole("status")).toHaveTextContent("system/environment proxy http://127.0.0.1:7890");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/connection-test$/), expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }));
  });

  it("recovers the connection-test controls after the client deadline", async () => {
    vi.useFakeTimers();
    useProfileStore.getState().updateProfile(useProfileStore.getState().selectedProfileId, { parameters: { timeout: 1 } });
    installProfileApi({ connection: (signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }) });
    render(ProfileSettings, { open: true, onclose: () => undefined });

    await fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(screen.getByRole("button", { name: "Testing…" })).toBeDisabled();
    await vi.advanceTimersByTimeAsync(3000);

    expect(screen.getByRole("status")).toHaveTextContent("Connection test timed out");
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
  });

  it("puts the enabled switch in the model summary", async () => {
    const user = userEvent.setup();
    render(ProfileSettings, { open: true, onclose: () => undefined });
    const toggle = screen.getByRole("button", { name: "Toggle model availability" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(useProfileStore.getState().profiles.find((profile) => profile.id === useProfileStore.getState().selectedProfileId)?.enabled).toBe(false);
  });

  it("persists profile edits through the Prompt Agent API instead of the host bridge", async () => {
    const fetchMock = installProfileApi();
    const profileId = useProfileStore.getState().selectedProfileId;

    useProfileStore.getState().updateProfile(profileId, { displayName: "ABC" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/prompt-agent/api/profiles/${profileId}`, expect.objectContaining({ method: "PATCH" })));
    expect(window.__SD_FORGE_NEO_PROMPT_AGENT__).toBeUndefined();
  });

  it("keeps manual save retryable until Prompt Agent confirms persistence", async () => {
    const user = userEvent.setup();
    const fetchMock = installProfileApi({ failSecretSaves: 1 });
    render(ProfileSettings, { open: true, onclose: () => undefined });
    await user.click(screen.getByRole("tab", { name: "Connection" }));
    const input = screen.getByLabelText("API key");
    await user.type(input, "retry-secret");

    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Save failed"));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(input).toHaveValue("retry-secret");

    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved securely"));
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH").length).toBe(3);
  });

  it("does not claim success when a remote profile never had an API key", async () => {
    installProfileApi({ forceHasApiKey: false });
    render(ProfileSettings, { open: true, onclose: () => undefined });

    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("API key was not written to secure storage"));
    expect(screen.getByRole("status")).not.toHaveTextContent("Saved securely");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("keeps a complete API key draft out of requests until explicit save", async () => {
    const user = userEvent.setup();
    const profileId = useProfileStore.getState().selectedProfileId;
    const fetchMock = installProfileApi();
    render(ProfileSettings, { open: true, onclose: () => undefined });
    await user.click(screen.getByRole("tab", { name: "Connection" }));
    const input = screen.getByLabelText("API key");

    await user.type(input, "secret-typed-once");

    expect(input).toHaveValue("secret-typed-once");
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved securely"));
    const secretRequest = fetchMock.mock.calls.find(([, init]) => String((init as RequestInit | undefined)?.body ?? "").includes("secret-typed-once"));
    expect(secretRequest?.[0]).toBe(`/prompt-agent/api/profiles/${profileId}`);
    expect(JSON.parse(String((secretRequest?.[1] as RequestInit).body))).toEqual({ api_key: "secret-typed-once" });
    expect(window.__SD_FORGE_NEO_PROMPT_AGENT__).toBeUndefined();
  });

  it("switches language from the shadcn dropdown", async () => {
    const user = userEvent.setup();
    render(ProfileSettings, { open: true, onclose: () => undefined });
    await user.click(screen.getByRole("button", { name: "Language" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "简体中文" }));
    expect(useI18nStore.getState().manualLocale).toBe("zh-CN");
  });

  it("shows local runtime controls without the irrelevant connection tab", () => {
    const local = useProfileStore.getState().profiles.find((profile) => profile.runtime === "llama-once");
    expect(local).toBeDefined();
    useProfileStore.getState().selectProfile(local!.id);
    render(ProfileSettings, { open: true, onclose: () => undefined });
    expect(screen.getByRole("tab", { name: "Local" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Connection" })).not.toBeInTheDocument();
  });

  it("shows effective unsupported capabilities and blocks llama-once activation", () => {
    const local = useProfileStore.getState().profiles.find((profile) => profile.runtime === "llama-once");
    expect(local).toBeDefined();
    useProfileStore.getState().updateProfile(local!.id, { enabled: true });
    useProfileStore.getState().selectProfile(local!.id);
    render(ProfileSettings, { open: true, onclose: () => undefined });

    expect(screen.getByRole("status")).toHaveTextContent("Agent chat is unavailable for this runtime");
    expect(screen.getByRole("status")).toHaveTextContent("Streaming");
    expect(screen.getByRole("status")).toHaveTextContent("Tool calling");
    expect(screen.getByRole("status")).toHaveTextContent("Vision input");
    expect(screen.getByRole("button", { name: "Use model" })).toBeDisabled();
  });

  it("keeps local paths out of profile state and submits them only on explicit save", async () => {
    const user = userEvent.setup();
    const fetchMock = installProfileApi();
    const local = useProfileStore.getState().profiles.find((profile) => profile.runtime === "llama-once");
    expect(local).toBeDefined();
    useProfileStore.getState().selectProfile(local!.id);
    render(ProfileSettings, { open: true, onclose: () => undefined });
    await user.click(screen.getByRole("tab", { name: "Local" }));

    await user.type(screen.getByLabelText("GGUF path"), "C:/private/model.gguf");

    expect(JSON.stringify(useProfileStore.getState())).not.toContain("C:/private/model.gguf");
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => String((init as RequestInit | undefined)?.body ?? "").includes("C:/private/model.gguf"))).toBe(true));
  });

  it("requires alert-dialog confirmation before deletion", async () => {
    const user = userEvent.setup();
    render(ProfileSettings, { open: true, onclose: () => undefined });
    const count = useProfileStore.getState().profiles.length;
    const profile = useProfileStore.getState().profiles[0];
    await user.click(screen.getByRole("button", { name: `${profile.displayName} actions` }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(useProfileStore.getState().profiles).toHaveLength(count);
    await user.click(screen.getByRole("button", { name: "Delete profile" }));
    expect(useProfileStore.getState().profiles).toHaveLength(count - 1);
  });

  it("exposes active, teacher, session, and naming route controls", async () => {
    const user = userEvent.setup();
    render(ProfileSettings, { open: true, onclose: () => undefined });
    await user.click(screen.getByRole("tab", { name: "Routes" }));
    expect(screen.getByRole("combobox", { name: /Active profile/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Teacher profile/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Session model/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Naming model/ })).toBeInTheDocument();
  });
});
