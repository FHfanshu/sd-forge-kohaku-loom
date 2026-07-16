const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("locale hints resolve without recursing through their own export", async () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../javascript/kohaku_loom_01_i18n.js"), "utf8");
    const context = {
        CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
        fetch: async () => ({ ok: false, json: async () => ({}) }),
        localStorage: { getItem: () => null, removeItem() {}, setItem() {} },
        navigator: { language: "en-US", languages: ["en-US"] },
        window: { addEventListener() {}, dispatchEvent() {}, kohakuLoom: {} }
    };
    vm.runInNewContext(source, context);
    await context.window.kohakuLoom.loadI18nBundle();
    assert.equal(context.window.kohakuLoom.getLocaleHints().locale, "en");
});

test("released Svelte boot mounts only through the Forge UI callback", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../javascript/kohaku_loom_99_boot.js"), "utf8");
    let callback;
    let mounts = 0;
    const context = {
        window: {
            KohakuLoomSvelteUi: { UI_READY: true, mountSvelteUi: () => { mounts += 1; } },
            onUiLoaded: (next) => { callback = next; }
        }
    };
    vm.runInNewContext(source, context);
    assert.equal(mounts, 0);
    callback();
    assert.equal(mounts, 1);
});

test("generated Svelte bundle owns the UI runtime contract", () => {
    const config = fs.readFileSync(path.resolve(__dirname, "../frontend/vite.config.ts"), "utf8");
    const bundle = fs.readFileSync(path.resolve(__dirname, "../javascript/kohaku_loom_90_ui.js"), "utf8");
    assert.match(config, /name:\s*"KohakuLoomSvelteUiBundle"/);
    assert.match(bundle, /var KohakuLoomSvelteUiBundle=\(function/);
    assert.doesNotMatch(bundle, /var KohakuLoomSvelteUi=\(function/);
});

test("legacy browser UI sources and stylesheet are gone after cutover", () => {
    const root = path.resolve(__dirname, "..");
    [
        "style.css",
        "javascript/kohaku_loom_assistant.js",
        "javascript/kohaku_loom_boot.js",
        "javascript/kohaku_loom_sessions.js",
    ].forEach((relative) => assert.equal(fs.existsSync(path.join(root, relative)), false, relative));
});
