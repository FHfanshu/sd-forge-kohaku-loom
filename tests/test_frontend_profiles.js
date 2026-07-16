const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const modulePath = path.resolve(__dirname, "../javascript/kohaku_loom_03_profiles.js");

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
    global.window = { kohakuLoom: {}, localStorage: storage };
    global.localStorage = storage;
    require(modulePath);
    return window.kohakuLoom;
}

test("defaults contain exactly the five canonical profiles", () => {
    const tools = loadModule(new MemoryStorage());
    const state = tools.createDefaultProfileState();
    assert.equal(state.version, 2);
    assert.equal(state.active_profile_id, "gemini");
    assert.equal(state.teacher_profile_id, "gemini");
    assert.equal(state.session_profile_id, "local-llama-endpoint");
    assert.equal(state.naming_profile_id, "");
    assert.deepEqual(state.profiles.map((profile) => profile.id), [
        "gemini", "openai-compatible", "deepseek", "local-llama-endpoint", "local-llama-once"
    ]);
    assert.deepEqual(state.profiles.map((profile) => [profile.protocol, profile.runtime]), [
        ["gemini-native", "remote-http"],
        ["openai-chat-completions", "remote-http"],
        ["openai-chat-completions", "remote-http"],
        ["openai-chat-completions", "llama-endpoint"],
        ["openai-chat-completions", "llama-once"]
    ]);
    assert.equal(state.profiles[0].display_name, "Gemini");
    assert.equal(state.profiles[0].model_id, "gemini-model");
    assert.deepEqual(state.profiles[0].fallback_endpoints, []);
    assert.equal(state.profiles[1].display_name, "OpenAI-compatible");
    assert.equal(state.profiles[1].endpoint, "");
    assert.equal(state.profiles[1].model_id, "model");
    assert.deepEqual(state.profiles[1].fallback_endpoints, []);
    assert.deepEqual(state.profiles[1].capabilities, {
        tools: true, vision: false, streaming: true, reasoning: true
    });
    assert.equal(state.profiles[2].endpoint, "https://api.deepseek.com");
    assert.equal(state.profiles[2].model_id, "deepseek-model");
    assert.deepEqual(state.profiles[0].capabilities, {
        tools: true, vision: true, streaming: true, reasoning: true
    });
    assert.equal(state.profiles[4].n_ctx, 16384);
    assert.equal(state.profiles[4].model_path, "");
    assert.equal(state.profiles[4].mmproj_path, "");
    assert.equal(state.profiles[4].llama_server_path, "");
    assert.deepEqual(state.profiles.map((profile) => profile.enabled), [true, false, false, true, false]);
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
        "api_key", "has_api_key", "capabilities", "parameters", "model_info", "model_path", "mmproj_path", "llama_server_path", "n_ctx",
        "n_gpu_layers", "thinking"
    ]);
    assert.equal(Object.hasOwn(profile, "name"), false);
    assert.equal(Object.hasOwn(profile, "model"), false);
    assert.equal(profile.display_name, "Gemini");
    assert.equal(profile.model_id, "gemini-model");
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
    const storage = new MemoryStorage({ loom_assistant_profiles_v2: serialized, loom_assistant_model: "stale-legacy" });
    const tools = loadModule(storage);
    assert.equal(tools.profileStore.load().profiles[0].model_id, "gemini-model");
    assert.equal(storage.writes.length, 0);
});

test("old q3vl v2 profile state migrates without deleting the import source", () => {
    const tools = loadModule();
    const storage = new MemoryStorage();
    const state = tools.createDefaultProfileState();
    state.profiles.find((profile) => profile.id === "deepseek").enabled = true;
    state.active_profile_id = "deepseek";
    storage.setItem("q3vl_assistant_profiles_v2", tools.serializeProfileState(state));
    const store = tools.createProfileStore(storage);

    assert.equal(store.load().active_profile_id, "deepseek");
    assert.notEqual(storage.getItem("loom_assistant_profiles_v2"), null);
    assert.notEqual(storage.getItem("q3vl_assistant_profiles_v2"), null);
});

test("existing v2 state does not receive provider-specific presets", () => {
    const seedTools = loadModule(new MemoryStorage());
    const state = seedTools.createDefaultProfileState();
    state.profiles = state.profiles.filter((profile) => profile.id !== "openai-compatible");
    const storage = new MemoryStorage({ loom_assistant_profiles_v2: JSON.stringify(state) });
    const tools = loadModule(storage);
    const loaded = tools.profileStore.load();
    assert.equal(loaded.profiles.some((profile) => profile.id === "openai-compatible"), false);
    assert.equal(storage.writes.length, 0);
});

test("invalid existing v2 state does not replay stale legacy settings", () => {
    const storage = new MemoryStorage({
        loom_assistant_profiles_v2: "{broken-json",
        loom_assistant_backend: "openai",
        loom_assistant_model: "stale-legacy",
        loom_assistant_api_key_openai: "stale-secret"
    });
    const tools = loadModule(storage);
    const state = tools.profileStore.load();
    assert.equal(state.active_profile_id, "gemini");
    assert.equal(state.profiles[0].model_id, "gemini-model");
    assert.equal(JSON.stringify(state).includes("stale-secret"), false);
    assert.equal(storage.getItem(tools.PROFILE_STORAGE_KEY), "{broken-json");
    assert.equal(storage.writes.length, 0);
});

test("legacy migration preserves current config, keys, local paths, and active route", () => {
    const storage = new MemoryStorage({
        loom_assistant_backend: "openai",
        loom_assistant_endpoint: "https://openai.example/v1",
        loom_assistant_model: "custom-chat",
        loom_assistant_api_key_openai: "openai-secret",
        loom_assistant_api_key_moyuu: "moyuu-secret",
        loom_assistant_api_key_deepseek: "deepseek-secret",
        loom_assistant_chat_model_route: "remote",
        loom_assistant_vision_model_path: "D:\\models\\vision.gguf",
        loom_assistant_vision_mmproj_path: "D:\\models\\mmproj.gguf",
        loom_assistant_llama_server_path: "D:\\llama\\llama-server.exe",
        loom_assistant_n_ctx: "32768",
        loom_assistant_local_n_gpu_layers: "42"
    });
    const tools = loadModule(storage);
    const state = tools.profileStore.load();
    const active = state.profiles.find((profile) => profile.id === state.active_profile_id);
    assert.equal(active.protocol, "openai-chat-completions");
    assert.equal(active.runtime, "remote-http");
    assert.equal(active.endpoint, "https://openai.example/v1");
    assert.equal(active.model_id, "custom-chat");
    assert.equal(active.api_key, "openai-secret");
    assert.equal(state.profiles.find((profile) => profile.id === "gemini").api_key, "moyuu-secret");
    assert.equal(state.profiles.find((profile) => profile.id === "deepseek").api_key, "deepseek-secret");
    const local = state.profiles.find((profile) => profile.id === "local-llama-once");
    assert.equal(local.model_path, "D:\\models\\vision.gguf");
    assert.equal(local.mmproj_path, "D:\\models\\mmproj.gguf");
    assert.equal(local.llama_server_path, "D:\\llama\\llama-server.exe");
    assert.equal(local.n_ctx, 32768);
    assert.equal(local.n_gpu_layers, 42);
    assert.equal(storage.getItem("loom_assistant_api_key_openai"), "openai-secret");
    assert.deepEqual(new Set(storage.writes.map(([key]) => key)), new Set([tools.PROFILE_STORAGE_KEY]));

    storage.writes.length = 0;
    const refreshedTools = loadModule(storage);
    assert.equal(refreshedTools.profileStore.load().active_profile_id, active.id);
    assert.equal(storage.writes.length, 0);
});

test("migration storage failure leaves legacy keys and does not install partial state", () => {
    const storage = new MemoryStorage({ loom_assistant_model: "legacy-model" });
    storage.setItem = function (key) {
        this.writes.push([key]);
        throw new Error("quota exceeded");
    };
    const tools = loadModule(storage);
    assert.throws(() => tools.profileStore.load(), /quota exceeded/);
    assert.equal(storage.getItem("loom_assistant_model"), "legacy-model");
    assert.equal(storage.getItem(tools.PROFILE_STORAGE_KEY), null);
});

test("legacy secondary Moyuu route preserves its routed API key", () => {
    const storage = new MemoryStorage({
        loom_assistant_backend: "deepseek",
        loom_assistant_secondary_backend: "openai",
        loom_assistant_secondary_endpoint: "https://moyuu.cc",
        loom_assistant_secondary_model: "grok-4.5",
        loom_assistant_api_key_openai: "openai-secret",
        loom_assistant_api_key_moyuu: "moyuu-secret",
        loom_assistant_chat_model_route: "secondary"
    });
    const tools = loadModule(storage);
    const current = tools.profileStore.current();
    assert.equal(current.id, "openai-compatible");
    assert.equal(current.display_name, "OpenAI-compatible");
    assert.equal(current.endpoint, "https://moyuu.cc");
    assert.equal(current.model_id, "grok-4.5");
    assert.equal(current.api_key, "moyuu-secret");
    assert.equal(current.capabilities.streaming, true);
});

test("existing migrated secondary keeps its stable custom ID", () => {
    const seedTools = loadModule(new MemoryStorage());
    const state = seedTools.createDefaultProfileState();
    state.profiles.push(seedTools.normalizeModelProfile({
        id: "legacy-secondary",
        display_name: "Migrated secondary model",
        enabled: true,
        model_id: "grok-4.5",
        endpoint: "https://moyuu.cc"
    }));
    state.active_profile_id = "legacy-secondary";
    const storage = new MemoryStorage({ loom_assistant_profiles_v2: JSON.stringify(state) });
    const tools = loadModule(storage);
    const loaded = tools.profileStore.load();
    assert.equal(loaded.active_profile_id, "legacy-secondary");
    assert.equal(loaded.profiles.find((profile) => profile.id === "legacy-secondary").display_name, "Migrated secondary model");
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
    tools.profileStore.update("deepseek", { enabled: true });
    tools.profileStore.setActive("deepseek");
    tools.profileStore.delete("deepseek");
    const state = tools.profileStore.load();
    assert.equal(state.active_profile_id, "gemini");

    state.profiles.forEach((profile) => { profile.enabled = profile.id === "local-llama-once"; });
    state.profiles.find((profile) => profile.id === "local-llama-once").model_path = "D:\\models\\local.gguf";
    state.active_profile_id = "local-llama-once";
    state.teacher_profile_id = "local-llama-once";
    state.session_profile_id = "local-llama-once";
    state.naming_profile_id = "local-llama-once";
    tools.profileStore.save(state);
    assert.throws(() => tools.profileStore.delete("local-llama-once"), /at least one enabled profile/);
});

test("request projection isolates API keys and deep clones selected data", () => {
    const tools = loadModule(new MemoryStorage());
    tools.profileStore.update("gemini", { api_key: "gemini-secret", enabled: true });
    tools.profileStore.update("deepseek", { api_key: "deepseek-secret", enabled: true });
    const projection = tools.profileStore.requestProjection("gemini");
    const serialized = JSON.stringify(projection);
    assert.equal(projection.profile_id, "gemini");
    assert.equal(projection.model, "gemini-model");
    assert.equal(projection.api_key, undefined);
    assert.equal(serialized.includes("deepseek-secret"), false);
    assert.deepEqual(Object.keys(projection), [
        "profile_id", "protocol", "runtime", "endpoint", "fallback_endpoints", "model", "capabilities", "parameters",
        "model_path", "mmproj_path", "llama_server_path", "n_ctx", "n_gpu_layers", "thinking"
    ]);
    projection.parameters.temperature = 2;
    assert.equal(tools.profileStore.load().profiles.find((profile) => profile.id === "gemini").parameters.temperature, 0.35);
});

test("scrubbing browser keys retains only the encrypted-secret marker", () => {
    const tools = loadModule();
    const storage = new MemoryStorage();
    const store = tools.createProfileStore(storage);
    store.update("gemini", { api_key: "gemini-secret" });

    const state = store.scrubApiKeys();

    assert.equal(state.profiles[0].api_key, "");
    assert.equal(state.profiles[0].has_api_key, true);
    assert.equal(storage.getItem("loom_assistant_profiles_v2").includes("gemini-secret"), false);
});

test("refresh persistence retains profile selection and independent keys", () => {
    const storage = new MemoryStorage();
    let tools = loadModule(storage);
    tools.profileStore.update("gemini", { api_key: "key-a", enabled: true });
    tools.profileStore.update("deepseek", { api_key: "key-b", enabled: true });
    tools.profileStore.update("local-llama-once", { enabled: true, model_path: "D:\\models\\local.gguf" });
    tools.profileStore.setActive("deepseek");
    tools.profileStore.setTeacher("local-llama-once");
    tools.profileStore.setSession("local-llama-endpoint");

    tools = loadModule(storage);
    assert.equal(tools.profileStore.current().id, "deepseek");
    assert.equal(tools.profileStore.current().api_key, "key-b");
    assert.equal(tools.profileStore.teacher().id, "local-llama-once");
    assert.equal(tools.profileStore.session().id, "local-llama-endpoint");
    assert.throws(() => tools.profileStore.setSession("deepseek"), /non-local profile/);
    assert.equal(tools.profileStore.load().profiles.find((profile) => profile.id === "gemini").api_key, "key-a");
});
