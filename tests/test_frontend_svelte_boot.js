const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("locale hints resolve without recursing through their own export", async () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../javascript/prompt_agent_01_i18n.js"), "utf8");
    const context = {
        CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
        fetch: async () => ({ ok: false, json: async () => ({}) }),
        localStorage: { getItem: () => null, removeItem() {}, setItem() {} },
        navigator: { language: "en-US", languages: ["en-US"] },
        window: { addEventListener() {}, dispatchEvent() {}, __SD_FORGE_NEO_PROMPT_AGENT__: {} }
    };
    vm.runInNewContext(source, context);
    await context.window.__SD_FORGE_NEO_PROMPT_AGENT__.loadI18nBundle();
    assert.equal(context.window.__SD_FORGE_NEO_PROMPT_AGENT__.getLocaleHints().locale, "en");
});

test("legacy locale values migrate once without dual-writing", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../javascript/prompt_agent_01_i18n.js"), "utf8");
    const CustomEvent = class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
    const values = new Map([["kohaku_loom_locale", "zh-CN"]]);
    const writes = [];
    const removals = [];
    const storage = {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { writes.push([key, value]); values.set(key, value); },
        removeItem(key) { removals.push(key); values.delete(key); }
    };
    const context = {
        CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
        fetch: async () => ({ ok: false, json: async () => ({}) }),
        localStorage: storage,
        navigator: { language: "en-US", languages: ["en-US"] },
        window: { addEventListener() {}, dispatchEvent() {}, CustomEvent, __SD_FORGE_NEO_PROMPT_AGENT__: {} }
    };
    vm.runInNewContext(source, context);
    const tools = context.window.__SD_FORGE_NEO_PROMPT_AGENT__;
    assert.equal(tools.locale(), "zh-CN");
    assert.equal(values.get("prompt_agent_locale"), "zh-CN");
    assert.equal(values.has("kohaku_loom_locale"), false);
    assert.deepEqual(writes, [["prompt_agent_locale", "zh-CN"]]);
    assert.deepEqual(removals, ["loom_assistant_locale", "kohaku_loom_locale", "loom_locale"]);
    tools.setLocale("en");
    assert.deepEqual(writes, [["prompt_agent_locale", "zh-CN"], ["prompt_agent_locale", "en"]]);
    assert.equal(removals.includes("kohaku_loom_locale"), true);
    assert.equal(tools.migrateLegacyLocale(), null);
});

test("released Svelte boot mounts only through the Forge UI callback", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../javascript/prompt_agent_99_boot.js"), "utf8");
    let callback;
    let mounts = 0;
    const context = {
        document: { getElementById: () => null },
        window: {
            addEventListener() {},
            __SD_FORGE_NEO_PROMPT_AGENT__: { ui: { UI_READY: true, mountSvelteUi: () => { mounts += 1; } } },
            onUiLoaded: (next) => { callback = next; },
            setTimeout: () => 1
        }
    };
    vm.runInNewContext(source, context);
    assert.equal(mounts, 0);
    callback();
    assert.equal(mounts, 1);
});

test("generated Svelte bundle owns the UI runtime contract", () => {
    const config = fs.readFileSync(path.resolve(__dirname, "../frontend/vite.config.ts"), "utf8");
    const bundle = fs.readFileSync(path.resolve(__dirname, "../javascript/prompt_agent_90_ui.js"), "utf8");
    assert.match(config, /name:\s*"PromptAgentSvelteUiBundle"/);
    assert.match(bundle, /var\s+PromptAgentSvelteUiBundle\s*=\s*\(function/);
    assert.doesNotMatch(bundle, /var\s+PromptAgentSvelteUi\s*=\s*\(function/);
});
