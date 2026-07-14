const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const modulePath = path.resolve(__dirname, "../javascript/kohaku_loom_sessions.js");

function loadModule() {
    delete require.cache[modulePath];
    global.window = { kohakuLoom: { assistantState: {} } };
    global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    require(modulePath);
    return window.kohakuLoom;
}

test("session history search path encodes the query", () => {
    const tools = loadModule();
    assert.equal(tools.assistantSessionListPath(""), "/sessions");
    assert.equal(tools.assistantSessionListPath("red hair & sky"), "/sessions");
});

test("KT SSE parser preserves cursor and event payload", () => {
    const tools = loadModule();
    const event = tools.parseKtSseFrame('id: 7\nevent: text_delta\ndata: {"payload":{"text":"hi"}}');
    assert.equal(event.sequence, 7);
    assert.equal(event.type, "text_delta");
    assert.equal(event.payload.text, "hi");
});

test("KT Forge resource calls map to browser resource tools", () => {
    const tools = loadModule();
    assert.deepEqual(tools.adaptKtForgeTool("forge_resource", {
        action: "apply",
        kind: "lora",
        resource_id: "detailer"
    }), {
        tool: "apply_resource",
        arguments: {
            action: "apply",
            kind: "lora",
            resource_id: "detailer",
            id: "detailer"
        }
    });
    assert.deepEqual(tools.adaptKtForgeTool("initialize_prompt", { positive: "subject" }), {
        tool: "initialize_prompt",
        arguments: { positive: "subject", positive_prompt: "subject", negative_prompt: undefined }
    });
});

test("Gemini content-wrapped edit arguments normalize to the Forge edit contract", () => {
    const tools = loadModule();
    assert.deepEqual(tools.adaptKtForgeTool("edit_prompt", {
        content: JSON.stringify({
            positive_prompt: "dynamic subject",
            positive_prompt_hash: "fnv1a:positive",
            context_hash: "fnv1a:context"
        }),
        _: true
    }), {
        tool: "edit_prompt",
        arguments: {
            _: true,
            positive_prompt: "dynamic subject",
            positive_prompt_hash: "fnv1a:positive",
            context_hash: "fnv1a:context",
            field: "positive",
            prompt: "dynamic subject",
            base_hash: "fnv1a:positive"
        }
    });
});

test("KT mutation classification keeps read-only tools separate", () => {
    const tools = loadModule();
    assert.equal(tools.ktMutationTool("edit_prompt", {}), true);
    assert.equal(tools.ktMutationTool("initialize_prompt", {}), true);
    assert.equal(tools.ktMutationTool("forge_resource", { action: "apply" }), true);
    assert.equal(tools.ktMutationTool("forge_resource", { action: "inspect" }), false);
    assert.equal(tools.ktMutationTool("read_prompt", {}), false);
});

test("rewind snapshots persist by session and user-message index", () => {
    const storage = new Map();
    global.window = { kohakuLoom: { assistantState: {} } };
    global.localStorage = {
        getItem(key) { return storage.get(key) || null; },
        setItem(key, value) { storage.set(key, value); },
        removeItem(key) { storage.delete(key); }
    };
    delete require.cache[modulePath];
    require(modulePath);
    const tools = window.kohakuLoom;
    const snapshot = { active_target: "txt2img", controls: [{ root: "#txt2img", index: 0, value: "prompt" }] };

    tools.storeRewindSnapshot("session-a", 2, snapshot);

    assert.deepEqual(tools.rewindSnapshot("session-a", 2), snapshot);
    assert.equal(tools.rewindSnapshot("session-a", 1), null);
    assert.deepEqual(tools.rewindSnapshots("session-a"), { "2": snapshot });
});

test("profile settings import invalidates the active KT provider snapshot", async () => {
    const storage = new Map([
        ["loom_kt_session_profile_snapshot", "old-provider"],
        ["q3vl_assistant_profiles_v2", "legacy"]
    ]);
    global.window = { kohakuLoom: { assistantState: {} } };
    global.localStorage = {
        getItem(key) { return storage.get(key) || null; },
        setItem(key, value) { storage.set(key, value); },
        removeItem(key) { storage.delete(key); }
    };
    global.fetch = async function () {
        return { ok: true, status: 200, async json() { return { imported: 1 }; } };
    };
    delete require.cache[modulePath];
    require(modulePath);
    const tools = window.kohakuLoom;
    let scrubbed = false;
    tools.LEGACY_PROFILE_STORAGE_KEY = "q3vl_assistant_profiles_v2";
    tools.profileStore = {
        load() { return { profiles: [] }; },
        scrubApiKeys() { scrubbed = true; }
    };

    await tools.importAssistantProfiles(true, true);

    assert.equal(scrubbed, true);
    assert.equal(storage.has("loom_kt_session_profile_snapshot"), false);
    assert.equal(storage.has("q3vl_assistant_profiles_v2"), false);
    assert.equal(storage.get("loom_kt_profiles_imported_v1"), "1");
});

test("KT run controls show exactly one send or stop button", () => {
    const tools = loadModule();
    const send = { hidden: false };
    const stop = { hidden: true, disabled: true };
    const runtimeControls = [{ disabled: false }, { disabled: false }];
    tools.assistantPanel = function () {
        return {
            querySelector(selector) { return selector === "#loom_assistant_stop" ? stop : null; },
            querySelectorAll() { return runtimeControls; }
        };
    };

    tools.setAssistantRunning(send, true);
    assert.equal(send.hidden, true);
    assert.equal(stop.hidden, false);
    assert.equal(stop.disabled, false);
    assert.deepEqual(runtimeControls.map(function (control) { return control.disabled; }), [true, true]);

    tools.setAssistantRunning(send, false);
    assert.equal(send.hidden, false);
    assert.equal(stop.hidden, true);
    assert.equal(stop.disabled, true);
    assert.deepEqual(runtimeControls.map(function (control) { return control.disabled; }), [false, false]);
});

test("KT reasoning and usage events restore the streaming assistant UI", () => {
    const tools = loadModule();
    const rendered = [];
    const statuses = [];
    tools.addAssistantMessage = function () { return {}; };
    tools.renderAssistantMarkdown = function () { };
    tools.updateAssistantStreamingMessage = function (_item, text, reasoning) {
        rendered.push({ text, reasoning });
    };
    tools.formatAssistantTokenStatus = function (usage) {
        return `↑ ${usage.prompt_tokens} ↓ ${usage.completion_tokens}`;
    };
    tools.updateAssistantMessage = function (_item, role, text) { statuses.push({ role, text }); };
    const run = {
        turnId: "turn-1",
        text: "",
        reasoning: "",
        usage: null,
        streamItem: null,
        statusItem: {},
        streamController: { abort() {} },
        resolve() {}
    };

    tools.handleKtTurnEvent(run, { type: "reasoning_delta", payload: { turn_id: "turn-1", text: "plan " } });
    tools.handleKtTurnEvent(run, { type: "reasoning_delta", payload: { turn_id: "turn-1", text: "steps" } });
    tools.handleKtTurnEvent(run, { type: "text_delta", payload: { turn_id: "turn-1", text: "answer" } });
    tools.handleKtTurnEvent(run, { type: "usage", payload: { turn_id: "turn-1", usage: { prompt_tokens: 12, completion_tokens: 4 } } });

    assert.deepEqual(rendered.at(-1), { text: "answer", reasoning: "plan steps" });
    assert.deepEqual(statuses, [{ role: "status", text: "↑ 12 ↓ 4" }]);
});

test("KT tool reply retries without executing a mutation twice", async () => {
    const tools = loadModule();
    let executions = 0;
    let replies = 0;
    global.fetch = async function (url) {
        if (!String(url).includes("/tools/replies/request-1")) throw new Error(`unexpected URL: ${url}`);
        replies += 1;
        if (replies === 1) throw new TypeError("Failed to fetch");
        return { ok: true, status: 200, async json() { return { ok: true }; } };
    };
    tools.executeAssistantTool = async function () {
        executions += 1;
        return { ok: true, changed: true };
    };
    tools.addAssistantMessage = function () { };
    tools.assistantToolResultLabel = function () { return "applied"; };
    const run = {
        controller: { signal: { aborted: false } },
        cancelled: false,
        resourceMutationAllowed: false,
        toolRequests: new Set(),
        toolResults: new Map()
    };
    const event = {
        type: "tool_request",
        payload: { request_id: "request-1", tool: "edit_prompt", arguments: { patches: [] } }
    };

    await assert.rejects(() => tools.handleKtToolEvent(run, event), /Failed to fetch/);
    assert.equal(run.toolRequests.has("request-1"), false);
    assert.equal(run.toolResults.has("request-1"), true);
    await tools.handleKtToolEvent(run, event);

    assert.equal(executions, 1);
    assert.equal(replies, 2);
    assert.equal(run.toolRequests.has("request-1"), true);
    assert.equal(run.toolResults.has("request-1"), false);
});
