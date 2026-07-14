const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const corePath = path.resolve(__dirname, "../javascript/kohaku_loom.js");

function loadCore(profileStore) {
    delete require.cache[corePath];
    global.document = {
        body: {},
        getElementById() { return null; },
        querySelectorAll() { return []; }
    };
    global.window = { kohakuLoom: profileStore ? { profileStore } : {} };
    require(corePath);
    return window.kohakuLoom;
}

test("assistant config requires the version 2 profile store", () => {
    const tools = loadCore(null);
    assert.throws(() => tools.assistantConfig(), /Profile store is unavailable/);
});

test("assistant config projects only the explicitly selected profile", () => {
    const profiles = [
        { id: "active", enabled: true, display_name: "Active", runtime: "remote-http" },
        { id: "teacher", enabled: true, display_name: "Teacher", runtime: "remote-http" }
    ];
    const projections = {
        active: {
            profile_id: "active", protocol: "openai-chat-completions", runtime: "remote-http",
            endpoint: "https://active.example/v1", fallback_endpoints: [], model: "active-model",
            api_key: "active-secret", capabilities: { streaming: true }, parameters: { timeout: 30 }
        },
        teacher: {
            profile_id: "teacher", protocol: "gemini-native", runtime: "remote-http",
            endpoint: "https://teacher.example", fallback_endpoints: [], model: "teacher-model",
            api_key: "teacher-secret", capabilities: { streaming: false }, parameters: { timeout: 60 }
        }
    };
    const store = {
        load() { return { active_profile_id: "active", teacher_profile_id: "teacher", session_profile_id: "", profiles }; },
        requestProjection(id) { return JSON.parse(JSON.stringify(projections[id])); }
    };
    const tools = loadCore(store);
    const active = tools.assistantConfig();
    const teacher = tools.assistantConfig("teacher");
    assert.equal(active.api_key, "active-secret");
    assert.equal(JSON.stringify(active).includes("teacher-secret"), false);
    assert.equal(teacher.api_key, "teacher-secret");
    assert.equal(JSON.stringify(teacher).includes("active-secret"), false);
    assert.equal(teacher.stream, false);
});

test("assistant config projects the configured local session metadata profile", () => {
    const profiles = [
        { id: "active", enabled: true, display_name: "Active", runtime: "remote-http" },
        { id: "metadata", enabled: true, display_name: "Metadata", runtime: "llama-endpoint" }
    ];
    const store = {
        load() { return { active_profile_id: "active", teacher_profile_id: "active", session_profile_id: "metadata", profiles }; },
        requestProjection(id) { return { profile_id: id, protocol: "openai-chat-completions", runtime: id === "metadata" ? "llama-endpoint" : "remote-http", endpoint: "http://localhost/v1", model: `${id}-model`, capabilities: {}, parameters: {} }; }
    };
    const config = loadCore(store).assistantConfig();
    assert.equal(config.session_profile_id, "metadata");
    assert.equal(config.session_profile.profile_id, "metadata");
    assert.equal(config.session_profile.runtime, "llama-endpoint");
});

test("token status accepts KT and legacy usage field names", () => {
    const tools = loadCore();
    assert.equal(
        tools.formatAssistantTokenStatus({ prompt_tokens: 18, completion_tokens: 7, reasoning_tokens: 3 }),
        "思考中... ↑ 18 tokens ↓ 7 tokens (thinking 3)"
    );
    assert.equal(
        tools.formatAssistantTokenStatus({ input_tokens: 9, output_tokens: 2, cached_tokens: 4 }),
        "思考中... ↑ 9 tokens ↓ 2 tokens (cache 4)"
    );
});

test("positive prompt guard detects no-phrase exclusions", () => {
    const tools = loadCore(null);
    assert.deepEqual(tools.positivePromptNoPhrases("portrait, no hat, no background"), ["no hat", "no background"]);
    assert.deepEqual(tools.positivePromptNoPhrases("portrait, noir lighting"), []);
});

test("replace_n scans the original prompt and cannot replace its own output", () => {
    const tools = loadCore(null);
    assert.deepEqual(
        tools.applyPromptPatchText("a a", { operation: "replace_n", find: "a", replace: "aa", count: 2 }),
        { ok: true, text: "aa aa", changed: 2 }
    );
    assert.equal(tools.applyPromptPatchText("a", { operation: "replace_n", find: "a", replace: "aa", count: 1000000000 }).ok, false);
});
