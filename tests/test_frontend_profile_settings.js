const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const profilesPath = path.resolve(__dirname, "../javascript/kohaku_loom_03_profiles.js");
const settingsPath = path.resolve(__dirname, "../javascript/kohaku_loom_04_profile_settings.js");

class MemoryStorage {
    constructor() {
        this.values = new Map();
    }

    getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        this.values.set(key, String(value));
    }
}

function loadModules() {
    delete require.cache[profilesPath];
    delete require.cache[settingsPath];
    const storage = new MemoryStorage();
    global.window = { kohakuLoom: {}, localStorage: storage };
    global.localStorage = storage;
    require(profilesPath);
    require(settingsPath);
    return window.kohakuLoom;
}

test("settings module exports its boot integration APIs", () => {
    const tools = loadModules();
    [
        "setupModelProfileSettingsWindow",
        "openModelProfileSettings",
        "renderModelProfileSettings",
        "testModelProfileConnection",
        "profileWorkspaceTabs",
        "profileRoleLabels"
    ].forEach((name) => assert.equal(typeof tools[name], "function", name));
});

test("workspace tabs expose local controls only for local runtimes", () => {
    const tools = loadModules();
    assert.deepEqual(tools.profileWorkspaceTabs({ runtime: "remote-http" }), ["overview", "connection", "generation"]);
    assert.deepEqual(tools.profileWorkspaceTabs({ runtime: "llama-endpoint" }), ["overview", "connection", "generation", "local"]);
    assert.deepEqual(tools.profileWorkspaceTabs({ runtime: "llama-once" }), ["overview", "connection", "generation", "local"]);
});

test("profile roles describe active, teacher, and session routing", () => {
    const tools = loadModules();
    const state = { active_profile_id: "main", teacher_profile_id: "main", session_profile_id: "local" };
    assert.deepEqual(tools.profileRoleLabels(state, { id: "main" }), ["active", "teacher"]);
    assert.deepEqual(tools.profileRoleLabels(state, { id: "local" }), ["session"]);
    assert.deepEqual(tools.profileRoleLabels(state, { id: "other" }), []);
});

test("protocol abbreviations remain compact and deterministic", () => {
    const tools = loadModules();
    assert.equal(tools.profileProtocolAbbreviation("gemini-native"), "GEM");
    assert.equal(tools.profileProtocolAbbreviation("openai-chat-completions"), "OAI");
    assert.equal(tools.profileProtocolAbbreviation("custom"), "API");
});

test("profile setting visibility follows runtime and capabilities", () => {
    const tools = loadModules();
    assert.deepEqual(tools.profileSettingsVisibility({
        runtime: "remote-http",
        capabilities: { vision: true, reasoning: true }
    }), {
        endpoint: true,
        fallback_endpoints: true,
        api_key: true,
        local: false,
        mmproj_path: false,
        thinking: false,
        reasoning_effort: true,
        temperature: true
    });
    assert.deepEqual(tools.profileSettingsVisibility({
        runtime: "llama-once",
        capabilities: { vision: false, reasoning: false }
    }), {
        endpoint: false,
        fallback_endpoints: false,
        api_key: false,
        local: true,
        mmproj_path: false,
        thinking: false,
        reasoning_effort: false,
        temperature: true
    });
    const endpoint = tools.profileSettingsVisibility({
        runtime: "llama-endpoint",
        capabilities: { vision: true, reasoning: true }
    });
    assert.equal(endpoint.endpoint, true);
    assert.equal(endpoint.local, true);
    assert.equal(endpoint.mmproj_path, true);
    assert.equal(endpoint.thinking, true);
});

test("connection test payload is minimal, tools-disabled, and keeps only the projected key", () => {
    const tools = loadModules();
    tools.profileStore.update("moyuu-gemini", { api_key: "selected-secret" });
    tools.profileStore.update("deepseek", { api_key: "other-secret" });
    const projection = tools.profileStore.requestProjection("moyuu-gemini");
    const payload = tools.buildModelProfileTestPayload(projection, "health ping");
    const serialized = JSON.stringify(payload);
    assert.equal(payload.api_key, undefined);
    assert.equal(serialized.includes("other-secret"), false);
    assert.equal(payload.disable_tools, true);
    assert.equal(payload.stream, false);
    assert.equal(payload.teacher_mode, "regex");
    assert.equal(payload.qwen_teacher_enabled, false);
    assert.deepEqual(payload.messages, [{ role: "user", content: "health ping" }]);
    assert.equal(payload.model, "gemini-3.1-pro-high");
});
