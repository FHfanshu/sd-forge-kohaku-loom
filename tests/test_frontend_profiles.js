const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const modulePath = path.resolve(__dirname, "../javascript/qwen3vl_prompt_tools_03_profiles.js");

class MemoryStorage {
    constructor(initial) {
        this.values = new Map(Object.entries(initial || {}));
        this.writes = [];
    }

    getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        this.values.set(key, String(value));
        this.writes.push([key, String(value)]);
    }
}

function loadModule(storage) {
    delete require.cache[modulePath];
    global.window = { q3vlPromptTools: {}, localStorage: storage };
    global.localStorage = storage;
    require(modulePath);
    return window.q3vlPromptTools;
}

test("defaults contain exactly the five canonical profiles", () => {
    const tools = loadModule(new MemoryStorage());
    const state = tools.createDefaultProfileState();
    assert.equal(state.version, 2);
    assert.equal(state.active_profile_id, "moyuu-gemini");
    assert.equal(state.teacher_profile_id, "moyuu-gemini");
    assert.equal(state.session_profile_id, "local-qwen-once");
    assert.deepEqual(state.profiles.map((profile) => profile.id), [
        "moyuu-gemini", "grok", "deepseek", "local-llama-endpoint", "local-qwen-once"
    ]);
    assert.deepEqual(state.profiles.map((profile) => [profile.protocol, profile.runtime]), [
        ["gemini-native", "remote-http"],
        ["openai-chat-completions", "remote-http"],
        ["openai-chat-completions", "remote-http"],
        ["openai-chat-completions", "llama-endpoint"],
        ["openai-chat-completions", "llama-once"]
    ]);
    assert.equal(state.profiles[0].display_name, "Moyuu Gemini");
    assert.equal(state.profiles[0].model_id, "gemini-3.1-pro-high");
    assert.deepEqual(state.profiles[0].fallback_endpoints, ["https://hk-api.moyuu.cc"]);
    assert.equal(state.profiles[1].display_name, "Grok");
    assert.equal(state.profiles[1].endpoint, "https://moyuu.cc");
    assert.equal(state.profiles[1].model_id, "grok-4.5");
    assert.deepEqual(state.profiles[1].fallback_endpoints, ["https://hk-api.moyuu.cc"]);
    assert.deepEqual(state.profiles[1].capabilities, {
        tools: true, vision: false, streaming: true, reasoning: true
    });
    assert.equal(state.profiles[2].endpoint, "https://api.deepseek.com");
    assert.equal(state.profiles[2].model_id, "deepseek-v4-pro");
    assert.deepEqual(state.profiles[0].capabilities, {
        tools: true, vision: true, streaming: true, reasoning: true
    });
    assert.equal(state.profiles[4].n_ctx, 16384);
    assert.match(state.profiles[4].model_path, /Qwen3\.5-9B-UD-Q6_K_XL\.gguf$/);
    assert.match(state.profiles[4].mmproj_path, /mmproj-F16\.gguf$/);
    assert.match(state.profiles[4].llama_server_path, /llama-server\.exe$/);
});

test("serialize and load normalize data without sharing references", () => {
    const storage = new MemoryStorage();
    const tools = loadModule(storage);
    const original = tools.createDefaultProfileState();
    original.profiles[0].api_key = "moyuu-secret";
    const serialized = tools.serializeProfileState(original);
    const parsed = tools.deserializeProfileState(serialized);
    parsed.profiles[0].parameters.temperature = 1.2;
    assert.equal(original.profiles[0].parameters.temperature, 0.35);

    const saved = tools.profileStore.save(original);
    saved.profiles[0].api_key = "changed-outside";
    assert.equal(tools.profileStore.load().profiles[0].api_key, "moyuu-secret");
    assert.deepEqual(storage.writes.map(([key]) => key), [tools.PROFILE_STORAGE_KEY]);
});

test("serialization persists only canonical profile fields", () => {
    const tools = loadModule(new MemoryStorage());
    const state = tools.createDefaultProfileState();
    state.profiles[0].name = "ignored alias";
    state.profiles[0].model = "ignored-alias-model";
    const profile = JSON.parse(tools.serializeProfileState(state)).profiles[0];
    assert.deepEqual(Object.keys(profile), [
        "id", "display_name", "enabled", "protocol", "runtime", "endpoint", "fallback_endpoints", "model_id",
        "api_key", "capabilities", "parameters", "model_info", "model_path", "mmproj_path", "llama_server_path", "n_ctx",
        "n_gpu_layers", "thinking"
    ]);
    assert.equal(Object.hasOwn(profile, "name"), false);
    assert.equal(Object.hasOwn(profile, "model"), false);
    assert.equal(profile.display_name, "Moyuu Gemini");
    assert.equal(profile.model_id, "gemini-3.1-pro-high");
    assert.deepEqual(Object.keys(profile.capabilities), ["tools", "vision", "streaming", "reasoning"]);
    assert.deepEqual(Object.keys(profile.parameters), [
        "temperature", "top_p", "max_tokens", "reasoning_effort", "timeout", "sanitize_sensitive", "teacher_mode"
    ]);
});

test("normalization accepts name and model as read aliases", () => {
    const tools = loadModule(new MemoryStorage());
    const profile = tools.normalizeModelProfile({ name: "Legacy alias", model: "legacy-model" });
    assert.equal(profile.display_name, "Legacy alias");
    assert.equal(profile.model_id, "legacy-model");
    assert.equal(Object.hasOwn(profile, "name"), false);
    assert.equal(Object.hasOwn(profile, "model"), false);
});

test("valid v2 state loads without migration or storage writes", () => {
    const seedTools = loadModule(new MemoryStorage());
    const serialized = seedTools.serializeProfileState(seedTools.createDefaultProfileState());
    const storage = new MemoryStorage({ q3vl_assistant_profiles_v2: serialized, q3vl_assistant_model: "stale-legacy" });
    const tools = loadModule(storage);
    assert.equal(tools.profileStore.load().profiles[0].model_id, "gemini-3.1-pro-high");
    assert.equal(storage.writes.length, 0);
});

test("existing v2 state receives the canonical streaming Grok preset", () => {
    const seedTools = loadModule(new MemoryStorage());
    const state = seedTools.createDefaultProfileState();
    state.profiles = state.profiles.filter((profile) => profile.id !== "grok");
    const storage = new MemoryStorage({ q3vl_assistant_profiles_v2: JSON.stringify(state) });
    const tools = loadModule(storage);
    const loaded = tools.profileStore.load();
    const grok = loaded.profiles.find((profile) => profile.id === "grok");
    assert.equal(grok.display_name, "Grok");
    assert.equal(grok.model_id, "grok-4.5");
    assert.equal(grok.capabilities.streaming, true);
    assert.equal(storage.writes.length, 0);
});

test("invalid existing v2 state does not replay stale legacy settings", () => {
    const storage = new MemoryStorage({
        q3vl_assistant_profiles_v2: "{broken-json",
        q3vl_assistant_backend: "openai",
        q3vl_assistant_model: "stale-legacy",
        q3vl_assistant_api_key_openai: "stale-secret"
    });
    const tools = loadModule(storage);
    const state = tools.profileStore.load();
    assert.equal(state.active_profile_id, "moyuu-gemini");
    assert.equal(state.profiles[0].model_id, "gemini-3.1-pro-high");
    assert.equal(JSON.stringify(state).includes("stale-secret"), false);
    assert.equal(storage.getItem(tools.PROFILE_STORAGE_KEY), "{broken-json");
    assert.equal(storage.writes.length, 0);
});

test("legacy migration preserves current config, keys, local paths, and active route", () => {
    const storage = new MemoryStorage({
        q3vl_assistant_backend: "openai",
        q3vl_assistant_endpoint: "https://openai.example/v1",
        q3vl_assistant_model: "custom-chat",
        q3vl_assistant_api_key_openai: "openai-secret",
        q3vl_assistant_api_key_moyuu: "moyuu-secret",
        q3vl_assistant_api_key_deepseek: "deepseek-secret",
        q3vl_assistant_chat_model_route: "remote",
        q3vl_assistant_vision_model_path: "D:\\models\\vision.gguf",
        q3vl_assistant_vision_mmproj_path: "D:\\models\\mmproj.gguf",
        q3vl_assistant_llama_server_path: "D:\\llama\\llama-server.exe",
        q3vl_assistant_n_ctx: "32768",
        q3vl_assistant_local_n_gpu_layers: "42"
    });
    const tools = loadModule(storage);
    const state = tools.profileStore.load();
    const active = state.profiles.find((profile) => profile.id === state.active_profile_id);
    assert.equal(active.protocol, "openai-chat-completions");
    assert.equal(active.runtime, "remote-http");
    assert.equal(active.endpoint, "https://openai.example/v1");
    assert.equal(active.model_id, "custom-chat");
    assert.equal(active.api_key, "openai-secret");
    assert.equal(state.profiles.find((profile) => profile.id === "moyuu-gemini").api_key, "moyuu-secret");
    assert.equal(state.profiles.find((profile) => profile.id === "deepseek").api_key, "deepseek-secret");
    const local = state.profiles.find((profile) => profile.id === "local-qwen-once");
    assert.equal(local.model_path, "D:\\models\\vision.gguf");
    assert.equal(local.mmproj_path, "D:\\models\\mmproj.gguf");
    assert.equal(local.llama_server_path, "D:\\llama\\llama-server.exe");
    assert.equal(local.n_ctx, 32768);
    assert.equal(local.n_gpu_layers, 42);
    assert.equal(storage.getItem("q3vl_assistant_api_key_openai"), "openai-secret");
    assert.deepEqual(new Set(storage.writes.map(([key]) => key)), new Set([tools.PROFILE_STORAGE_KEY]));

    storage.writes.length = 0;
    const refreshedTools = loadModule(storage);
    assert.equal(refreshedTools.profileStore.load().active_profile_id, active.id);
    assert.equal(storage.writes.length, 0);
});

test("migration storage failure leaves legacy keys and does not install partial state", () => {
    const storage = new MemoryStorage({ q3vl_assistant_model: "legacy-model" });
    storage.setItem = function (key) {
        this.writes.push([key]);
        throw new Error("quota exceeded");
    };
    const tools = loadModule(storage);
    assert.throws(() => tools.profileStore.load(), /quota exceeded/);
    assert.equal(storage.getItem("q3vl_assistant_model"), "legacy-model");
    assert.equal(storage.getItem(tools.PROFILE_STORAGE_KEY), null);
});

test("legacy secondary Moyuu route preserves its routed API key", () => {
    const storage = new MemoryStorage({
        q3vl_assistant_backend: "deepseek",
        q3vl_assistant_secondary_backend: "openai",
        q3vl_assistant_secondary_endpoint: "https://moyuu.cc",
        q3vl_assistant_secondary_model: "grok-4.5",
        q3vl_assistant_api_key_openai: "openai-secret",
        q3vl_assistant_api_key_moyuu: "moyuu-secret",
        q3vl_assistant_chat_model_route: "secondary"
    });
    const tools = loadModule(storage);
    const current = tools.profileStore.current();
    assert.equal(current.id, "grok");
    assert.equal(current.display_name, "Grok");
    assert.equal(current.endpoint, "https://moyuu.cc");
    assert.equal(current.model_id, "grok-4.5");
    assert.equal(current.api_key, "moyuu-secret");
    assert.equal(current.capabilities.streaming, true);
});

test("existing migrated Grok secondary receives the canonical name and ID", () => {
    const seedTools = loadModule(new MemoryStorage());
    const state = seedTools.createDefaultProfileState();
    state.profiles = state.profiles.filter((profile) => profile.id !== "grok");
    state.profiles.push(seedTools.normalizeModelProfile({
        id: "legacy-secondary",
        display_name: "Migrated secondary model",
        model_id: "grok-4.5",
        endpoint: "https://moyuu.cc"
    }));
    state.active_profile_id = "legacy-secondary";
    const storage = new MemoryStorage({ q3vl_assistant_profiles_v2: JSON.stringify(state) });
    const tools = loadModule(storage);
    const loaded = tools.profileStore.load();
    assert.equal(loaded.active_profile_id, "grok");
    assert.equal(loaded.profiles.some((profile) => profile.id === "legacy-secondary"), false);
    assert.equal(loaded.profiles.find((profile) => profile.id === "grok").display_name, "Grok");
});

test("add, duplicate, update, and delete keep stable unique IDs", () => {
    const tools = loadModule(new MemoryStorage());
    const added = tools.profileStore.add({ name: "Custom", model: "custom-model", api_key: "custom-secret" });
    const duplicated = tools.profileStore.duplicate(added.id);
    assert.notEqual(duplicated.id, added.id);
    assert.equal(duplicated.api_key, "custom-secret");
    assert.equal(added.display_name, "Custom");
    assert.equal(added.model_id, "custom-model");
    assert.equal(duplicated.display_name, "Custom copy");
    tools.profileStore.update(added.id, { parameters: { temperature: 0.8 }, display_name: "Renamed custom profile" });
    const updated = tools.profileStore.load().profiles.find((profile) => profile.id === added.id);
    assert.equal(updated.display_name, "Renamed custom profile");
    assert.equal(updated.parameters.temperature, 0.8);
    assert.equal(updated.parameters.top_p, 0.9);
    assert.equal(tools.profileStore.delete(duplicated.id).id, duplicated.id);
    assert.equal(tools.profileStore.load().profiles.some((profile) => profile.id === duplicated.id), false);
});

test("deleting the active profile selects the first enabled fallback", () => {
    const tools = loadModule(new MemoryStorage());
    tools.profileStore.setActive("deepseek");
    tools.profileStore.delete("deepseek");
    const state = tools.profileStore.load();
    assert.equal(state.active_profile_id, "moyuu-gemini");

    state.profiles.forEach((profile) => { profile.enabled = profile.id === "local-qwen-once"; });
    state.active_profile_id = "local-qwen-once";
    state.teacher_profile_id = "local-qwen-once";
    tools.profileStore.save(state);
    assert.throws(() => tools.profileStore.delete("local-qwen-once"), /at least one enabled profile/);
});

test("request projection isolates API keys and deep clones selected data", () => {
    const tools = loadModule(new MemoryStorage());
    tools.profileStore.update("moyuu-gemini", { api_key: "moyuu-secret" });
    tools.profileStore.update("deepseek", { api_key: "deepseek-secret" });
    const projection = tools.profileStore.requestProjection("moyuu-gemini");
    const serialized = JSON.stringify(projection);
    assert.equal(projection.profile_id, "moyuu-gemini");
    assert.equal(projection.model, "gemini-3.1-pro-high");
    assert.equal(projection.api_key, "moyuu-secret");
    assert.equal(serialized.includes("deepseek-secret"), false);
    assert.deepEqual(Object.keys(projection), [
        "profile_id", "protocol", "runtime", "endpoint", "fallback_endpoints", "model", "api_key", "capabilities", "parameters",
        "model_path", "mmproj_path", "llama_server_path", "n_ctx", "n_gpu_layers", "thinking"
    ]);
    projection.parameters.temperature = 2;
    assert.equal(tools.profileStore.current().parameters.temperature, 0.35);
});

test("refresh persistence retains profile selection and independent keys", () => {
    const storage = new MemoryStorage();
    let tools = loadModule(storage);
    tools.profileStore.update("moyuu-gemini", { api_key: "key-a" });
    tools.profileStore.update("deepseek", { api_key: "key-b" });
    tools.profileStore.setActive("deepseek");
    tools.profileStore.setTeacher("local-qwen-once");
    tools.profileStore.setSession("local-llama-endpoint");

    tools = loadModule(storage);
    assert.equal(tools.profileStore.current().id, "deepseek");
    assert.equal(tools.profileStore.current().api_key, "key-b");
    assert.equal(tools.profileStore.teacher().id, "local-qwen-once");
    assert.equal(tools.profileStore.session().id, "local-llama-endpoint");
    assert.throws(() => tools.profileStore.setSession("deepseek"), /non-local profile/);
    assert.equal(tools.profileStore.load().profiles.find((profile) => profile.id === "moyuu-gemini").api_key, "key-a");
});
