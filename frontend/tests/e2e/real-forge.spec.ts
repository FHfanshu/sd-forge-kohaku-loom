import { expect, test } from "@playwright/test";

type PromptToolResult = {
  ok?: boolean;
  error?: string;
  positive_prompt?: string;
  positive_prompt_hash?: string;
};

const promptSelector = "#txt2img_prompt textarea, #txt2img_prompt input";

async function runPromptTool(page: import("@playwright/test").Page, tool: string, argumentsValue: Record<string, unknown>): Promise<PromptToolResult> {
  return page.evaluate(async ({ tool, argumentsValue }) => {
    const api = (window as Window & {
      __SD_FORGE_NEO_PROMPT_AGENT__?: { hostApi?: { executeAssistantTool?: (value: unknown) => Promise<PromptToolResult> } };
    }).__SD_FORGE_NEO_PROMPT_AGENT__?.hostApi;
    if (typeof api?.executeAssistantTool !== "function") throw new Error("Prompt Agent host tool bridge is unavailable");
    return await api.executeAssistantTool({ tool, arguments: argumentsValue });
  }, { tool, argumentsValue });
}

test("changes and restores a real Forge txt2img prompt through Prompt Agent", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#tabs")).toBeVisible();
  const prompt = page.locator(promptSelector).first();
  await expect(prompt).toBeVisible();
  await expect(page.getByRole("button", { name: /Prompt Agent/i })).toBeVisible();

  const original = await prompt.inputValue();
  const marker = `local_ci_prompt-agent_${Date.now()}`;
  let changed = false;

  try {
    const read = await runPromptTool(page, "read_prompt", { target: "txt2img" });
    expect(read.ok, read.error).toBe(true);
    expect(read.positive_prompt_hash).toBeTruthy();

    const edit = await runPromptTool(page, "edit_prompt", {
      target: "txt2img",
      field: "positive",
      base_hash: read.positive_prompt_hash,
      patches: [{ operation: "append", separator: read.positive_prompt ? ", " : "", text: marker }],
      return_prompt: true,
    });
    expect(edit.ok, edit.error).toBe(true);
    changed = true;
    await expect(prompt).toHaveValue(new RegExp(marker));

    const verified = await runPromptTool(page, "read_prompt", { target: "txt2img" });
    expect(verified.ok, verified.error).toBe(true);
    expect(verified.positive_prompt).toContain(marker);
  } finally {
    const current = await runPromptTool(page, "read_prompt", { target: "txt2img" }).catch(() => null);
    if (current?.ok && current.positive_prompt !== original) {
      const restore = await runPromptTool(page, "edit_prompt", {
        target: "txt2img",
        field: "positive",
        base_hash: current.positive_prompt_hash,
        patches: [{ operation: "replace", find: current.positive_prompt ?? "", replace: original }],
        return_prompt: true,
      });
      expect(restore.ok, restore.error).toBe(true);
    }
    if (changed) await expect(prompt).toHaveValue(original);
  }
});

test.describe("real tablet model path", () => {
  test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

  test("tests the selected model and changes the prompt through the real composer", async ({ page }) => {
    const profileId = process.env.FORGE_MODEL_PROFILE_ID;
    await page.goto("/");
    await expect(page.locator("#tabs")).toBeVisible();
    const prompt = page.locator(promptSelector).first();
    await expect(prompt).toBeVisible();
    const original = await prompt.inputValue();
    const marker = `model_e2e_prompt-agent_${Date.now()}`;
    let directMode = false;

    try {
      await page.getByRole("button", { name: /Prompt Agent/i }).click();
      const chat = page.getByRole("dialog", { name: /Prompt Agent|助手/i });
      await expect(chat).toBeVisible();
      await chat.locator(".pa-header-controls .pa-header-icon").nth(2).click();
      const settings = page.locator(".pa-profile-window");
      await expect(settings).toBeVisible();
      await expect(chat).toBeVisible();
      await expect(settings.getByRole("button", { name: /Resize profile window|调整模型配置窗口大小/i })).toBeVisible();
      const settingsBox = await settings.boundingBox();
      expect(settingsBox).not.toBeNull();
      expect(settingsBox!.width).toBeLessThan(820);
      expect(settingsBox!.height).toBeLessThan(1180);

      if (profileId) {
        const selected = await page.evaluate(async (id) => {
          const response = await fetch("/prompt-agent/api/profiles");
          const state = await response.json() as { profiles?: Array<{ id?: string; display_name?: string; displayName?: string }> };
          const profile = state.profiles?.find((item) => item.id === id);
          if (!profile) return "";
          await fetch("/prompt-agent/api/profile-routes/default", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "active", profile_id: id }) });
          return String(profile.display_name || profile.displayName || id);
        }, profileId);
        if (!selected) throw new Error(`FORGE_MODEL_PROFILE_ID does not match an available profile: ${profileId}`);
        await page.reload();
        await page.getByRole("button", { name: /Prompt Agent/i }).click();
        await page.getByRole("dialog", { name: /Prompt Agent|助手/i }).locator(".pa-header-controls .pa-header-icon").nth(2).click();
      }

      const currentSettings = page.locator(".pa-profile-window");
      await currentSettings.locator(".pa-profile-summary-actions [data-slot='button']").first().click();
      await expect(currentSettings.locator(".pa-profile-status")).toContainText(/Connection successful|连接成功/, { timeout: 65_000 });
      await expect(currentSettings.locator(".pa-profile-status")).toContainText(/Route:|连接路径：/);
      await currentSettings.locator(".pa-profile-window-actions .pa-header-icon").last().click();

      const currentChat = page.getByRole("dialog", { name: /Prompt Agent|助手/i });
      const permission = currentChat.locator(".pa-permission-toggle");
      if (await permission.getAttribute("aria-pressed") !== "true") {
        await permission.click();
        await page.locator(".pa-dialog-confirm").click();
        directMode = true;
      }

      const composer = currentChat.getByRole("textbox");
      await composer.fill(`Use read_prompt on txt2img, then use edit_prompt to append exactly ${marker} to the positive prompt. Perform the tool calls now and do not only describe them.`);
      await currentChat.getByRole("button", { name: /Send message|发送消息/i }).click();
      await expect(prompt).toHaveValue(new RegExp(marker), { timeout: 180_000 });
      const stop = currentChat.getByRole("button", { name: /Stop response|停止响应/i });
      if (await stop.isVisible().catch(() => false)) await stop.click();
    } finally {
      const current = await runPromptTool(page, "read_prompt", { target: "txt2img" }).catch(() => null);
      if (current?.ok && current.positive_prompt !== original) {
        const restore = await runPromptTool(page, "edit_prompt", {
          target: "txt2img",
          field: "positive",
          base_hash: current.positive_prompt_hash,
          patches: [{ operation: "replace", find: current.positive_prompt ?? "", replace: original }],
          return_prompt: true,
        });
        expect(restore.ok, restore.error).toBe(true);
      }
      const permission = page.locator(".pa-permission-toggle");
      if (directMode && await permission.isVisible().catch(() => false) && await permission.getAttribute("aria-pressed") === "true") await permission.click();
      await expect(prompt).toHaveValue(original);
    }
  });
});
