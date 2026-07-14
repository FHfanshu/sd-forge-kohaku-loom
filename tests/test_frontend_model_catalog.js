const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const modulePath = path.resolve(__dirname, "../javascript/qwen3vl_prompt_tools_05_model_catalog.js");

function loadModule() {
    delete require.cache[modulePath];
    global.window = { q3vlPromptTools: {} };
    require(modulePath);
    return window.q3vlPromptTools;
}

const catalog = {
    deepseek: {
        id: "deepseek",
        api: "https://api.deepseek.com",
        models: {
            "deepseek-v4-pro": {
                id: "deepseek-v4-pro", attachment: false, reasoning: true, tool_call: true, temperature: true,
                reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
                modalities: { input: ["text"] }, limit: { context: 1000000, output: 384000 }
            }
        }
    },
    relay: {
        id: "relay",
        api: "https://relay.example.com/v1",
        models: { "deepseek-v4-pro": { id: "deepseek-v4-pro", reasoning: true, reasoning_options: [] } }
    }
};

test("models.dev matching prefers the provider whose API host matches the profile endpoint", () => {
    const tools = loadModule();
    const match = tools.findModelsDevModel(catalog, { endpoint: "https://api.deepseek.com", model_id: "deepseek-v4-pro" });
    assert.equal(match.provider.id, "deepseek");
});

test("models.dev patch projects capabilities, limits, and discrete reasoning options", () => {
    const tools = loadModule();
    const match = tools.findModelsDevModel(catalog, { endpoint: "https://api.deepseek.com", model_id: "deepseek-v4-pro-high" });
    const patch = tools.modelsDevProfilePatch(match);
    assert.deepEqual(patch.capabilities, { tools: true, vision: false, reasoning: true, streaming: true });
    assert.deepEqual(patch.parameters, {});
    assert.equal(patch.model_info.reasoning_toggle, true);
    assert.deepEqual(patch.model_info.reasoning_efforts, ["high", "max"]);
    assert.equal(patch.model_info.context_limit, 1000000);
});

test("catalog fetch is cached and returns a profile patch", async () => {
    const tools = loadModule();
    let calls = 0;
    const fetchImpl = async () => ({ ok: true, json: async () => catalog, status: 200 });
    const first = await tools.syncProfileFromModelsDev({ endpoint: "https://api.deepseek.com", model_id: "deepseek-v4-pro" }, async (...args) => { calls += 1; return fetchImpl(...args); });
    await tools.syncProfileFromModelsDev({ endpoint: "https://api.deepseek.com", model_id: "deepseek-v4-pro" }, fetchImpl);
    assert.equal(calls, 1);
    assert.equal(first.patch.model_info.provider_id, "deepseek");
    assert.equal(first.patch.parameters.reasoning_effort, "high");
});
