import { expect, test, type Page } from "@playwright/test";

async function capture(page: Page, name: string): Promise<void> {
  const directory = process.env.KL_VISUAL_DIR;
  if (directory) await page.screenshot({ path: `${directory}/${name}.png` });
}

async function installMockHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const capabilities = [
      "forge-availability", "prompt-target", "forge-state", "tool-execution",
      "profile-store", "tool-bridge-lease", "assistant-config", "session-runtime",
      "legacy-sessions", "locale-hints",
    ];
    const profiles = [
      {
        id: "mock-remote", display_name: "Mock Qwen", model_id: "qwen-mock", enabled: true,
        protocol: "openai-chat-completions", runtime: "remote-http", endpoint: "https://mock.invalid/v1",
        capabilities: { tools: true, vision: true, streaming: true, reasoning: true },
        parameters: { temperature: 0.25, top_p: 0.9, max_tokens: 4096, reasoning_effort: "low", timeout: 30, sanitize_sensitive: true, teacher_mode: "qwen-redact" },
      },
      {
        id: "mock-local", display_name: "Mock local", model_id: "qwen-local", enabled: true,
        protocol: "openai-chat-completions", runtime: "llama-once", endpoint: "http://127.0.0.1:8080/v1",
        model_path: "C:/models/mock.gguf", capabilities: { tools: true, vision: true, streaming: true, reasoning: true },
        parameters: { temperature: 0.25, top_p: 0.9, max_tokens: 4096, reasoning_effort: "low", timeout: 30, sanitize_sensitive: true, teacher_mode: "qwen-redact" },
      },
    ];
    const state = {
      version: 2,
      active_profile_id: "mock-remote",
      teacher_profile_id: "mock-remote",
      session_profile_id: "mock-local",
      naming_profile_id: "mock-local",
      profiles,
    };
    const profileById = (id: string) => state.profiles.find((profile) => profile.id === id) ?? state.profiles[0];
    const profileStore = {
      load: () => structuredClone(state),
      current: () => structuredClone(profileById(state.active_profile_id)),
      teacher: () => structuredClone(profileById(state.teacher_profile_id)),
      session: () => structuredClone(profileById(state.session_profile_id)),
      add: (profile: Record<string, unknown>) => {
        const next = { ...structuredClone(state.profiles[0]), ...profile, id: String(profile.id ?? `profile-${state.profiles.length + 1}`) };
        state.profiles.push(next);
        return structuredClone(next);
      },
      duplicate: (id: string) => {
        const source = profileById(id);
        const next = { ...structuredClone(source), id: `${id}-copy`, display_name: `${source.display_name} copy` };
        state.profiles.push(next);
        return structuredClone(next);
      },
      update: (id: string, patch: Record<string, unknown>) => {
        const profile = profileById(id);
        Object.assign(profile, patch);
        if (patch.capabilities) profile.capabilities = { ...profile.capabilities, ...patch.capabilities as object };
        if (patch.parameters) profile.parameters = { ...profile.parameters, ...patch.parameters as object };
        return structuredClone(profile);
      },
      delete: (id: string) => {
        const index = state.profiles.findIndex((profile) => profile.id === id);
        if (index >= 0 && state.profiles.length > 1) state.profiles.splice(index, 1);
        return structuredClone(profileById(state.active_profile_id));
      },
      setActive: (id: string) => { state.active_profile_id = id; return structuredClone(profileById(id)); },
      setTeacher: (id: string) => { state.teacher_profile_id = id; return structuredClone(profileById(id)); },
      setSession: (id: string) => { state.session_profile_id = id; return structuredClone(profileById(id)); },
      setNaming: (id: string) => { state.naming_profile_id = id; return structuredClone(profileById(id)); },
      restoreDefaults: () => structuredClone(state),
      requestProjection: (id?: string) => structuredClone(profileById(id ?? state.active_profile_id)),
    };
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
    const empty = () => new Response(null, { status: 204 });
    let queued = false;
    const queuedMessage = () => ({ message_id: "queued-1", display_content: "Queued follow-up", content: "Queued follow-up", attachments: [], state: "pending", created_at: Date.now() });
    const sse = (slow: boolean, signal?: AbortSignal | null) => {
      const encoder = new TextEncoder();
      let closed = false;
      const timers: number[] = [];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (delay: number, frame: string, close = false) => {
            timers.push(window.setTimeout(() => {
              if (closed) return;
              controller.enqueue(encoder.encode(frame));
              if (close) { closed = true; controller.close(); }
            }, delay));
          };
          emit(60, `id: 1\nevent: message\ndata: ${JSON.stringify({ type: "text_delta", payload: { turn_id: "turn-1", text: "Mock assistant " } })}\n\n`);
          emit(slow ? 1600 : 160, `id: 2\nevent: message\ndata: ${JSON.stringify({ type: "turn_ended", payload: { turn_id: "turn-1", status: "completed", text: "Mock assistant reply", usage: { input_tokens: 12, output_tokens: 4, latency_ms: 160 } } })}\n\n`, true);
          signal?.addEventListener("abort", () => {
            if (closed) return;
            closed = true;
            timers.forEach(window.clearTimeout);
            try { controller.close(); } catch { /* already cancelled */ }
          }, { once: true });
        },
        cancel() { closed = true; timers.forEach(window.clearTimeout); },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.href);
      const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
      const signal = init?.signal ?? request?.signal;
      if (url.pathname === "/kohaku-loom/i18n/locale") {
        return json({ locale: "en", fallback_locale: "en", supported_locales: ["en", "zh-CN"], content_version: "e2e", metadata: { code: "en", label: "English", direction: "ltr", source: "python-runtime", content_version: "e2e" } });
      }
      if (url.pathname === "/kohaku-loom/i18n") {
        const locale = url.searchParams.get("locale") === "zh-CN" ? "zh-CN" : "en";
        return json({ locale, fallback_locale: "en", content_version: "e2e", messages: {}, metadata: { code: locale, label: locale === "zh-CN" ? "简体中文" : "English", direction: "ltr", source: "python-runtime", content_version: "e2e" } });
      }
      if (url.pathname === "/kohaku-loom/kt/sessions" && method === "GET") {
        return json({ sessions: [{ session_id: "archived-1", title: "Mock archived chat", preview: "A previous prompt review", modified_at: 1_700_000_000, message_count: 2 }] });
      }
      if (url.pathname === "/kohaku-loom/kt/runtime") return json({ active_session: null, turn_event_sequence: 0, tool_event_sequence: 0, messages: queued ? [queuedMessage()] : [] });
      if (url.pathname === "/kohaku-loom/kt/sessions/open" && method === "POST") return json({ session: { session_id: "mock-session", profile_id: "mock-remote", agent_mode: "normal" } });
      if (url.pathname === "/kohaku-loom/kt/sessions/close" && method === "POST") return empty();
      if (url.pathname === "/kohaku-loom/kt/sessions/mock-session" && method === "GET") return json({ messages: [], queue: [], branches: null });
      if (url.pathname === "/kohaku-loom/kt/turns/events") return sse(Boolean((window as Window & { __mockSlowTurn?: boolean }).__mockSlowTurn), signal);
      if (url.pathname === "/kohaku-loom/kt/tools/events") return new Response(": ready\n\n", { headers: { "Content-Type": "text/event-stream" } });
      if (url.pathname === "/kohaku-loom/kt/turns" && method === "POST") return json({ turn_id: "turn-1" });
      if (url.pathname === "/kohaku-loom/kt/sessions/mock-session/messages" && method === "POST") {
        queued = true;
        return json({ message: queuedMessage() });
      }
      if (url.pathname === "/kohaku-loom/kt/sessions/mock-session/messages/queued-1/cancel" && method === "POST") {
        queued = false;
        return json({ message: { ...queuedMessage(), state: "cancelled" } });
      }
      if (url.pathname === "/kohaku-loom/kt/turns/turn-1/cancel" && method === "POST") return json({ status: "interrupted" });
      return nativeFetch(input, init);
    };
    const bridgeResponse = (request: { client?: string; apiVersion?: number }) => request.client === "kohaku-loom-svelte-ui" && request.apiVersion === 1
      ? { ok: true, bridge: "kohaku-loom-svelte-ui", apiVersion: 1, version: "1.0.0", capabilities }
      : { ok: false, bridge: "kohaku-loom-svelte-ui", apiVersion: 1, reason: "client-mismatch" };
    window.kohakuLoom = {
      hostApi: {
        name: "kohaku-loom-host", version: "1.0.0", apiVersion: 1, capabilities,
        handshake: bridgeResponse,
        isForgeAvailable: () => true,
        activePromptTarget: () => "txt2img",
        readPrompt: async () => ({ positive_prompt: "portrait, window light", negative_prompt: "blurry" }),
        captureForgeState: () => ({ prompt: "portrait, window light" }),
        restoreForgeState: () => true,
        executeTool: async () => ({ ok: true }),
        executeAssistantTool: async () => ({ ok: true }),
        assistantConfig: () => ({ profile_id: "mock-remote", timeout: 30, parameters: { timeout: 30 } }),
        profileStore,
        claimToolBridge: async () => ({ owned: true, bridge_id: "mock-bridge", pending_requests: [] }),
        claimAssistantToolBridge: async () => ({ owned: true, bridge_id: "mock-bridge", pending_requests: [] }),
        syncProfiles: async () => ({}),
        profileChat: async () => ({ text: "OK" }),
        listLegacySessions: async () => ({ sessions: [{ id: "legacy-1", title: "Legacy prompt session", preview: "Imported history", message_count: 1, modified_at: 1_690_000_000 }] }),
        getLegacySession: async () => ({ events: [{ event_type: "user_message", message: { content: "Legacy message" } }] }),
        ktBaseUrl: "/kohaku-loom/kt",
        getLocaleHints: () => ({ locale: "en", supported_locales: ["en", "zh-CN"], source: "forge-metadata" }),
        subscribeLocaleHints: () => () => undefined,
        openSettings: () => undefined,
      },
    };
  });
}

test("module loading alone does not bypass the Forge boot callback", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#tabs")).toHaveAttribute("data-legacy-owned", "true");
  await expect(page.locator("#txt2img_prompt")).toHaveAttribute("data-legacy-owned", "true");
  await expect(page.locator("#kohaku-loom-svelte-mount")).toHaveCount(0);
});

test("mounted desktop UI exercises chat, history, profiles, and attachments", async ({ page }) => {
  test.setTimeout(20_000);
  await installMockHost(page);
  await page.goto("/?mount=1");
  await expect(page.locator("#kohaku-loom-svelte-mount")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open Kohaku Loom" })).toBeVisible();
  await page.getByRole("button", { name: "Open Kohaku Loom" }).click();
  await expect(page.getByRole("dialog", { name: "Kohaku Loom chat" })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message Kohaku Loom" });
  const singleLineHeight = await composer.evaluate((element) => element.getBoundingClientRect().height);
  await composer.fill("one\ntwo\nthree");
  const multiLineHeight = await composer.evaluate((element) => element.getBoundingClientRect().height);
  expect(multiLineHeight).toBeGreaterThan(singleLineHeight);
  await composer.fill(Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n"));
  const cappedHeight = await composer.evaluate((element) => element.getBoundingClientRect().height);
  expect(cappedHeight).toBeLessThanOrEqual(132);
  await composer.fill("");

  await page.getByRole("button", { name: "Active model" }).click();
  const modelPicker = page.getByRole("dialog", { name: "Select model" });
  await expect(modelPicker).toBeVisible();
  expect((await modelPicker.boundingBox())!.width).toBeLessThanOrEqual(442);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Change reasoning effort" }).click();
  const reasoning = page.getByRole("dialog", { name: "Reasoning effort" });
  await expect(reasoning).toBeVisible();
  const reasoningSlider = reasoning.getByRole("slider", { name: "Reasoning effort" });
  await expect(reasoningSlider).toBeVisible();
  await reasoningSlider.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "3";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.getByRole("button", { name: "Change reasoning effort" })).toHaveText("High");
  await capture(page, "reasoning-popover");

  await page.getByRole("button", { name: "Open chat history" }).click();
  await expect(page.getByRole("option", { name: "Mock archived chat" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Legacy prompt session" })).toBeVisible();
  await page.getByRole("button", { name: "Open chat history" }).click();

  const fileInput = page.locator('input[type="file"][multiple]');
  await fileInput.setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: Buffer.from("mock-image") });
  await expect(page.getByRole("button", { name: "Preview reference.png" })).toBeVisible();
  await page.getByRole("button", { name: "Preview reference.png" }).click();
  await expect(page.getByRole("dialog", { name: "Image preview" })).toBeVisible();
  await page.getByRole("button", { name: "Close preview" }).click();

  await page.getByRole("textbox", { name: "Message Kohaku Loom" }).fill("Review this composition");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Review this composition", { exact: true })).toBeVisible();
  await expect(page.getByText("Mock assistant reply", { exact: true })).toBeVisible();
  await expect(page.getByText("12 in · 4 out · 0.2s", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("dialog", { name: "Model profiles" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("tab", { name: "Local" })).toHaveCount(0);
  await expect(settings.getByRole("tab", { name: "Interface" })).toHaveCount(0);
  await capture(page, "settings-remote");
  await settings.getByRole("tab", { name: "Generation" }).click();
  await expect(settings.getByRole("slider", { name: "Reasoning effort" })).toBeVisible();
  await capture(page, "settings-generation");
  await settings.getByRole("tab", { name: "Routes" }).click();
  await expect(settings.getByRole("combobox", { name: /Active profile/ })).toBeVisible();
  await expect(settings.getByRole("combobox", { name: /Teacher profile/ })).toBeVisible();
  await expect(settings.getByRole("combobox", { name: /Session model/ })).toBeVisible();
  await expect(settings.getByRole("combobox", { name: /Naming model/ })).toBeVisible();
  await settings.getByRole("button", { name: "Language" }).click();
  await page.getByRole("menuitemradio", { name: "简体中文" }).click();
  await expect(settings.getByRole("tab", { name: "路由" })).toBeVisible();
});

test("active turns queue follow-ups and cancel locally", async ({ page }) => {
  test.setTimeout(20_000);
  await installMockHost(page);
  await page.addInitScript(() => { (window as Window & { __mockSlowTurn?: boolean }).__mockSlowTurn = true; });
  await page.goto("/?mount=1");
  await page.getByRole("button", { name: "Open Kohaku Loom" }).click();
  const input = page.getByRole("textbox", { name: "Message Kohaku Loom" });
  await input.fill("Start a slow response");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
  await expect(page.getByText("Mock assistant", { exact: true })).toBeVisible();
  await expect(page.getByText("Generating response…", { exact: true })).toBeVisible();
  await capture(page, "assistant-working");
  await input.fill("Queued follow-up");
  await page.getByRole("button", { name: "Queue message" }).click();
  await expect(page.getByLabel("Queued messages")).toContainText("Queued follow-up");
  await page.getByRole("button", { name: "Stop response" }).click();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop response" })).toHaveCount(0);
  await page.getByRole("button", { name: /Remove queued message/ }).click();
  await expect(page.getByLabel("Queued messages")).toHaveCount(0);
});

test.describe("mobile layout", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("portrait and landscape windows remain inside the viewport", async ({ page }) => {
    await installMockHost(page);
    await page.goto("/?mount=1");
    await page.getByRole("button", { name: "Open Kohaku Loom" }).click();
    const chat = page.getByRole("dialog", { name: "Kohaku Loom chat" });
    const portrait = await chat.boundingBox();
    expect(portrait).not.toBeNull();
    expect(portrait!.x).toBeGreaterThanOrEqual(0);
    expect(portrait!.y).toBeGreaterThanOrEqual(0);
    expect(portrait!.x + portrait!.width).toBeLessThanOrEqual(390);
    expect(portrait!.y + portrait!.height).toBeLessThanOrEqual(844);
    const composer = await page.getByRole("textbox", { name: "Message Kohaku Loom" }).boundingBox();
    expect(composer).not.toBeNull();
    expect(composer!.x).toBeGreaterThanOrEqual(portrait!.x);
    expect(composer!.x + composer!.width).toBeLessThanOrEqual(portrait!.x + portrait!.width);
    const send = await page.getByRole("button", { name: "Send message" }).boundingBox();
    expect(send).not.toBeNull();
    expect(send!.x + send!.width).toBeLessThanOrEqual(portrait!.x + portrait!.width);
    await page.getByRole("button", { name: "Active model" }).click();
    const modelPicker = await page.getByRole("dialog", { name: "Select model" }).boundingBox();
    expect(modelPicker).not.toBeNull();
    expect(modelPicker!.x).toBeGreaterThanOrEqual(0);
    expect(modelPicker!.x + modelPicker!.width).toBeLessThanOrEqual(390);
    expect(modelPicker!.y).toBeGreaterThanOrEqual(0);
    expect(modelPicker!.y + modelPicker!.height).toBeLessThanOrEqual(844);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 844, height: 390 });
    const landscape = await chat.boundingBox();
    expect(landscape).not.toBeNull();
    expect(landscape!.x).toBeGreaterThanOrEqual(0);
    expect(landscape!.y).toBeGreaterThanOrEqual(0);
    expect(landscape!.x + landscape!.width).toBeLessThanOrEqual(844);
    expect(landscape!.y + landscape!.height).toBeLessThanOrEqual(390);

    await page.getByRole("button", { name: "Open settings" }).click();
    await expect(chat).toHaveCount(0);
    const settings = page.getByRole("dialog", { name: "Model profiles" });
    await expect(settings).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Kohaku Loom" })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "Resize profile window" })).toHaveCount(0);
    const settingsBox = await settings.boundingBox();
    expect(settingsBox).not.toBeNull();
    expect(settingsBox!.x).toBe(0);
    expect(settingsBox!.y).toBe(0);
    expect(settingsBox!.width).toBe(844);
    expect(settingsBox!.height).toBe(390);
    await capture(page, "settings-mobile");
    await settings.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog", { name: "Kohaku Loom chat" })).toBeVisible();
  });
});
