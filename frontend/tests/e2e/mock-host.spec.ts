import { expect, test, type Page } from "@playwright/test";

async function capture(page: Page, name: string): Promise<void> {
  const directory = process.env.PROMPT_AGENT_VISUAL_DIR;
  if (directory) await page.screenshot({ path: `${directory}/${name}.png` });
}

async function installMockHost(page: Page, hostDelayMs = 0): Promise<void> {
  await page.addInitScript((delay) => {
    const capabilities = [
      "forge-availability", "prompt-target", "forge-state", "tool-execution", "locale-hints",
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
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
    const empty = () => new Response(null, { status: 204 });
    const browserState = window as Window & {
      __mockRequestBodies?: unknown[];
      __mockRevokedObjectUrls?: string[];
      __mockStreamRequestCount?: number;
      __mockToolExecutionCount?: number;
    };
    browserState.__mockRequestBodies = [];
    browserState.__mockRevokedObjectUrls = [];
    browserState.__mockStreamRequestCount = Number(sessionStorage.getItem("mock-stream-request-count") ?? "0");
    browserState.__mockToolExecutionCount = Number(sessionStorage.getItem("mock-tool-execution-count") ?? "0");
    const nativeRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (value: string) => {
      browserState.__mockRevokedObjectUrls?.push(value);
      nativeRevokeObjectUrl(value);
    };
    const nativeFetch = window.fetch.bind(window);
    const promptAgentStream = (slow: boolean, signal?: AbortSignal | null) => {
      const encoder = new TextEncoder();
      let closed = false;
      const timers: number[] = [];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (delay: number, event: Record<string, unknown>, close = false) => {
            timers.push(window.setTimeout(() => {
              if (closed) return;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              if (close) { closed = true; controller.close(); }
            }, delay));
          };
          emit(0, { type: "start" });
          emit(60, { type: "text_start", contentIndex: 0 });
          emit(80, { type: "text_delta", contentIndex: 0, delta: "Mock assistant " });
          emit(slow ? 10_000 : 160, { type: "text_delta", contentIndex: 0, delta: "reply" });
          emit(slow ? 10_100 : 180, { type: "text_end", contentIndex: 0 });
          emit(slow ? 10_120 : 200, { type: "done", reason: "stop", usage: { input: 12, output: 4, totalTokens: 16, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }, true);
          const cancelTurn = () => {
            if (closed) return;
            closed = true;
            timers.forEach(window.clearTimeout);
            try { controller.close(); } catch { /* already cancelled */ }
          };
          signal?.addEventListener("abort", cancelTurn, { once: true });
        },
        cancel() { closed = true; timers.forEach(window.clearTimeout); },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    };
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.href);
      const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
      const signal = init?.signal ?? request?.signal;
      if (url.pathname === "/prompt-agent/api/i18n/locale") {
        return json({ locale: "en", fallback_locale: "en", supported_locales: ["en", "zh-CN"], content_version: "e2e", metadata: { code: "en", label: "English", direction: "ltr", source: "python-runtime", content_version: "e2e" } });
      }
      if (url.pathname === "/prompt-agent/api/i18n") {
        const locale = url.searchParams.get("locale") === "zh-CN" ? "zh-CN" : "en";
        return json({ locale, fallback_locale: "en", content_version: "e2e", messages: {}, metadata: { code: locale, label: locale === "zh-CN" ? "简体中文" : "English", direction: "ltr", source: "python-runtime", content_version: "e2e" } });
      }
      if (url.pathname === "/prompt-agent/api/profiles" && method === "GET") return json(state);
      if (url.pathname === "/prompt-agent/api/profiles/restore-defaults" && method === "POST") return json(state);
      if (url.pathname.startsWith("/prompt-agent/api/profiles/") && url.pathname.endsWith("/connection-test")) return json({ ok: true, transport: "mock provider" });
      if (url.pathname.startsWith("/prompt-agent/api/profiles/") && method === "PATCH") {
        const profile = state.profiles.find((item) => url.pathname.includes(`/${item.id}`)) ?? state.profiles[0];
        const patch = JSON.parse(String(init?.body ?? request?.body ?? "{}")) as Record<string, unknown>;
        Object.assign(profile, patch);
        if (patch.capabilities) profile.capabilities = { ...profile.capabilities, ...patch.capabilities as object };
        if (patch.parameters) profile.parameters = { ...profile.parameters, ...patch.parameters as object };
        return json(profile);
      }
      if (url.pathname === "/prompt-agent/api/profile-routes/default" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? request?.body ?? "{}")) as { role?: string; profile_id?: string };
        if (body.role && body.profile_id) (state as Record<string, unknown>)[`${body.role}_profile_id`] = body.profile_id;
        return json(state);
      }
      if (url.pathname === "/prompt-agent/api/stream" && method === "POST") {
        browserState.__mockRequestBodies?.push(JSON.parse(String(init?.body ?? request?.body ?? "{}")));
        browserState.__mockStreamRequestCount = (browserState.__mockStreamRequestCount ?? 0) + 1;
        sessionStorage.setItem("mock-stream-request-count", String(browserState.__mockStreamRequestCount));
        return promptAgentStream(Boolean((window as Window & { __mockSlowTurn?: boolean }).__mockSlowTurn), signal);
      }
      return nativeFetch(input, init);
    };
    const bridgeResponse = (request: { client?: string; apiVersion?: number }) => request.client === "prompt-agent-ui" && request.apiVersion === 1
      ? { ok: true, bridge: "prompt-agent-ui", apiVersion: 1, version: "1.0.0", capabilities }
      : { ok: false, bridge: "prompt-agent-ui", apiVersion: 1, reason: "client-mismatch" };
    const namespace = {
      hostApi: {
        name: "prompt-agent-host", version: "1.0.0", apiVersion: 1, capabilities,
        handshake: bridgeResponse,
        isForgeAvailable: () => true,
        activePromptTarget: () => "txt2img",
        readPrompt: async () => ({ positive_prompt: "portrait, window light", negative_prompt: "blurry" }),
        captureForgeState: () => ({ prompt: "portrait, window light" }),
        restoreForgeState: () => true,
        executeTool: async () => ({ ok: true }),
        executeAssistantTool: async () => {
          browserState.__mockToolExecutionCount = (browserState.__mockToolExecutionCount ?? 0) + 1;
          sessionStorage.setItem("mock-tool-execution-count", String(browserState.__mockToolExecutionCount));
          return { ok: true };
        },
        getLocaleHints: () => ({ locale: "en", supported_locales: ["en", "zh-CN"], source: "forge-metadata" }),
        subscribeLocaleHints: () => () => undefined,
        openSettings: () => undefined,
      },
    };
    if (delay > 0) window.setTimeout(() => { window.__SD_FORGE_NEO_PROMPT_AGENT__ = namespace; }, delay);
    else window.__SD_FORGE_NEO_PROMPT_AGENT__ = namespace;
  }, hostDelayMs);
}

test("module loading alone does not bypass the Forge boot callback", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#tabs")).toHaveAttribute("data-prompt-agent-host-owned", "true");
  await expect(page.locator("#txt2img_prompt")).toHaveAttribute("data-prompt-agent-host-owned", "true");
  await expect(page.locator("#prompt-agent-svelte-mount")).toHaveCount(0);
});

test("connects when the Svelte bundle loads before the Forge host", async ({ page }) => {
  await installMockHost(page, 2_500);
  await page.goto("/?mount=1");
  await expect(page.getByRole("button", { name: "Open Prompt Agent" })).toBeVisible();
  await page.getByRole("button", { name: "Open Prompt Agent" }).click();
  await expect(page.getByRole("dialog", { name: "Prompt Agent chat" })).toBeVisible();
  await expect(page.getByText("Connecting to Forge runtime…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Active model" })).toHaveText("Mock Qwen");
});

test("mounted desktop UI exercises chat, history, profiles, and attachments", async ({ page }) => {
  test.setTimeout(20_000);
  await installMockHost(page);
  await page.goto("/?mount=1");
  await expect(page.locator("#prompt-agent-svelte-mount")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open Prompt Agent" })).toBeVisible();
  await page.getByRole("button", { name: "Open Prompt Agent" }).click();
  await expect(page.getByRole("dialog", { name: "Prompt Agent chat" })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message Prompt Agent" });
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
  const pickerButtonBorders = await modelPicker.locator("button").evaluateAll((buttons) => buttons.map((button) => {
    const style = getComputedStyle(button);
    return {
      className: button.className,
      top: style.borderTopWidth,
      right: style.borderRightWidth,
      bottom: style.borderBottomWidth,
      left: style.borderLeftWidth,
    };
  }));
  expect(pickerButtonBorders).toEqual(expect.arrayContaining([
    expect.objectContaining({ className: "pa-model-picker-add", top: "0px", right: "0px", bottom: "0px", left: "0px" }),
    expect.objectContaining({ className: "pa-model-picker-row-main", top: "0px", right: "0px", bottom: "0px", left: "0px" }),
    expect.objectContaining({ className: "pa-model-picker-star is-favorite", top: "0px", right: "0px", bottom: "0px", left: "0px" }),
  ]));
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
  await expect(page.getByRole("option", { name: "New conversation" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Mock archived chat" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open chat history" }).click();

  const fileInput = page.locator('input[type="file"][multiple]');
  await fileInput.setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: Buffer.from("mock-image") });
  const attachmentPreview = page.getByRole("button", { name: "Preview reference.png" });
  await expect(attachmentPreview).toBeVisible();
  await expect(attachmentPreview.locator("img")).toHaveAttribute("src", /^blob:/);
  await page.getByRole("button", { name: "Preview reference.png" }).click();
  await expect(page.getByRole("dialog", { name: "Image preview" })).toBeVisible();
  await page.getByRole("button", { name: "Close preview" }).click();

  await page.getByRole("textbox", { name: "Message Prompt Agent" }).fill("Review this composition");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Review this composition", { exact: true })).toBeVisible();
  await expect(page.getByText("Mock assistant reply", { exact: true })).toBeVisible();
  const attachmentWireState = await page.evaluate(() => {
    const state = window as Window & { __mockRequestBodies?: unknown[]; __mockRevokedObjectUrls?: string[] };
    return { bodies: state.__mockRequestBodies ?? [], revoked: state.__mockRevokedObjectUrls ?? [] };
  });
  expect(attachmentWireState.bodies).toHaveLength(1);
  expect(attachmentWireState.bodies[0]).not.toHaveProperty("attachments");
  const wireJson = JSON.stringify(attachmentWireState.bodies[0]);
  expect(wireJson.match(/bW9jay1pbWFnZQ==/g)).toHaveLength(1);
  expect(wireJson).toContain('"mimeType":"image/png"');
  await expect.poll(async () => page.evaluate(() => (window as Window & { __mockRevokedObjectUrls?: string[] }).__mockRevokedObjectUrls?.length ?? 0)).toBe(1);
  await expect(page.getByText("12 in · 4 out", { exact: true })).toBeVisible();
  const userMessage = page.locator(".pa-message-user").filter({ hasText: "Review this composition" });
  await expect(userMessage).toBeVisible();
  await expect(userMessage.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  const userMessageStyle = await userMessage.evaluate((element) => {
    const style = getComputedStyle(element);
    return { alignSelf: style.alignSelf, backgroundColor: style.backgroundColor };
  });
  expect(userMessageStyle.alignSelf).toBe("flex-end");
  expect(userMessageStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  await capture(page, "chat-messages");

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

test("active turns abort and restore a usable composer", async ({ page }) => {
  test.setTimeout(20_000);
  await installMockHost(page);
  await page.addInitScript(() => { (window as Window & { __mockSlowTurn?: boolean }).__mockSlowTurn = true; });
  await page.goto("/?mount=1");
  await page.getByRole("button", { name: "Open Prompt Agent" }).click();
  const input = page.getByRole("textbox", { name: "Message Prompt Agent" });
  await input.fill("Start a slow response");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
  await expect(page.getByText("Mock assistant", { exact: true })).toBeVisible();
  await expect(page.getByText("Generating response…", { exact: true })).toBeVisible();
  await capture(page, "assistant-working");
  await page.getByRole("button", { name: "Stop response" }).click();
  await expect(page.getByRole("button", { name: "Stop response" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
});

test("refresh preserves partial content, interrupts unfinished work, and never resumes it", async ({ page }) => {
  test.setTimeout(20_000);
  await installMockHost(page);
  await page.addInitScript(() => { (window as Window & { __mockSlowTurn?: boolean }).__mockSlowTurn = true; });
  await page.goto("/?mount=1");
  await page.getByRole("button", { name: "Open Prompt Agent" }).click();
  const composer = page.getByRole("textbox", { name: "Message Prompt Agent" });
  await composer.fill("Persist this partial response");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Mock assistant", { exact: true })).toBeVisible();

  await expect.poll(async () => page.evaluate(async () => {
    const request = indexedDB.open("sd-forge-neo-prompt-agent", 2);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction("messages", "readonly");
      const messages = await new Promise<any[]>((resolve, reject) => {
        const all = transaction.objectStore("messages").getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => reject(all.error);
      });
      return messages.some((record) => record.status === "streaming"
        && JSON.stringify(record.message).includes("Mock assistant"));
    } finally {
      database.close();
    }
  })).toBe(true);

  await page.evaluate(async () => {
    const request = indexedDB.open("sd-forge-neo-prompt-agent", 2);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const read = database.transaction("messages", "readonly");
      const messages = await new Promise<any[]>((resolve, reject) => {
        const all = read.objectStore("messages").getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => reject(all.error);
      });
      const unfinished = messages.find((record) => record.status === "streaming"
        && record.message?.role === "assistant");
      if (!unfinished) throw new Error("streaming assistant record was not persisted");
      unfinished.message.content.push({ type: "toolCall", id: "stale-tool", name: "read_prompt", arguments: {} });
      const write = database.transaction("messages", "readwrite");
      write.objectStore("messages").put(unfinished);
      await new Promise<void>((resolve, reject) => {
        write.oncomplete = () => resolve();
        write.onerror = () => reject(write.error);
        write.onabort = () => reject(write.error);
      });
    } finally {
      database.close();
    }
  });

  await page.reload();
  await page.getByRole("button", { name: "Open Prompt Agent" }).click();
  await expect(page.getByText("Mock assistant", { exact: true })).toBeVisible();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  const resumed = await page.evaluate(() => {
    const state = window as Window & { __mockStreamRequestCount?: number; __mockToolExecutionCount?: number; __mockSlowTurn?: boolean };
    state.__mockSlowTurn = false;
    return { streams: state.__mockStreamRequestCount ?? 0, tools: state.__mockToolExecutionCount ?? 0 };
  });
  expect(resumed).toEqual({ streams: 1, tools: 0 });

  const restoredComposer = page.getByRole("textbox", { name: "Message Prompt Agent" });
  await restoredComposer.fill("Continue after refresh");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Mock assistant reply", { exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => (
    window as Window & { __mockStreamRequestCount?: number }
  ).__mockStreamRequestCount ?? 0)).toBe(2);
});

test.describe("mobile layout", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("portrait and landscape windows remain inside the viewport", async ({ page }) => {
    await installMockHost(page);
    await page.goto("/?mount=1");
    await page.getByRole("button", { name: "Open Prompt Agent" }).click();
    const chat = page.getByRole("dialog", { name: "Prompt Agent chat" });
    const portrait = await chat.boundingBox();
    expect(portrait).not.toBeNull();
    expect(portrait!.x).toBeGreaterThanOrEqual(0);
    expect(portrait!.y).toBeGreaterThanOrEqual(0);
    expect(portrait!.x + portrait!.width).toBeLessThanOrEqual(390);
    expect(portrait!.y + portrait!.height).toBeLessThanOrEqual(844);
    const composer = await page.getByRole("textbox", { name: "Message Prompt Agent" }).boundingBox();
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
    await expect(page.getByRole("button", { name: "Open Prompt Agent" })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "Resize profile window" })).toHaveCount(0);
    const settingsBox = await settings.boundingBox();
    expect(settingsBox).not.toBeNull();
    expect(settingsBox!.x).toBe(0);
    expect(settingsBox!.y).toBe(0);
    expect(settingsBox!.width).toBe(844);
    expect(settingsBox!.height).toBe(390);
    await capture(page, "settings-mobile");
    await settings.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog", { name: "Prompt Agent chat" })).toBeVisible();
  });
});

test.describe("tablet layout", () => {
  test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

  test("keeps chat and settings as bounded floating windows", async ({ page }) => {
    await installMockHost(page);
    await page.goto("/?mount=1");
    await page.getByRole("button", { name: "Open Prompt Agent" }).click();
    const chat = page.getByRole("dialog", { name: "Prompt Agent chat" });
    const tabletComposer = chat.getByRole("textbox", { name: "Message Prompt Agent" });
    await tabletComposer.fill("Touch copy check");
    await expect(chat.getByRole("button", { name: "Resize chat window" })).toHaveCount(0);
    await chat.getByRole("button", { name: "Send message" }).tap();
    await expect(tabletComposer).toBeFocused();
    await expect(chat.getByText("Mock assistant reply", { exact: true })).toBeVisible();
    await expect(chat.getByRole("button", { name: "Copy" }).first()).toBeVisible();
    await expect(chat.getByRole("button", { name: /Permission mode/ })).toHaveCount(0);
    expect(await page.locator("body > .pa-dialog-layer").count()).toBe(0);
    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Model profiles" });

    await expect(chat).toBeVisible();
    await expect(settings).toBeVisible();
    await expect(settings.getByRole("button", { name: "Resize profile window" })).toBeVisible();
    const portrait = await settings.boundingBox();
    expect(portrait).not.toBeNull();
    expect(portrait!.x).toBeGreaterThan(0);
    expect(portrait!.y).toBeGreaterThan(0);
    expect(portrait!.width).toBeLessThan(820);
    expect(portrait!.height).toBeLessThan(1180);

    await page.setViewportSize({ width: 1180, height: 820 });
    const landscape = await settings.boundingBox();
    expect(landscape).not.toBeNull();
    expect(landscape!.x + landscape!.width).toBeLessThanOrEqual(1180);
    expect(landscape!.y + landscape!.height).toBeLessThanOrEqual(820);
  });
});
