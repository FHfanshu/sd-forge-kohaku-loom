const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

global.window = {
    location: { origin: "http://127.0.0.1:7860" },
    setTimeout,
    __SD_FORGE_NEO_PROMPT_AGENT__: {
        assistantState: { loadedPromptSkills: {}, promptReads: {} },
        promptContextSnapshot: () => ({ context_hash: "ctx" }),
        promptFieldRootForTarget: () => ({ target: "txt2img", root: null }),
        promptAgentApp: () => ({ querySelector: () => null, querySelectorAll: () => [] }),
        readPromptTool: async () => ({}),
        positivePromptNoPhrases: () => [],
        setNativeValueIfAvailable: () => true,
        setTextboxValue: () => true,
        styleSelectorValue: () => "",
        textboxValue: () => ""
    }
};

require(path.resolve(__dirname, "../javascript/prompt_agent_02_resources.js"));
const tools = window.__SD_FORGE_NEO_PROMPT_AGENT__;

test("appendFragment is idempotent", () => {
    assert.deepEqual(tools.appendFragment("base", "__artists__"), { value: "base, __artists__", changed: true });
    assert.deepEqual(tools.appendFragment("base, __artists__", "__artists__"), { value: "base, __artists__", changed: false });
});

test("Danbooru tools are registered for agent execution", () => {
    assert.deepEqual([...tools.RESOURCE_TOOLS], [
        "search_resources",
        "inspect_resource",
        "search_danbooru_tags",
        "inspect_danbooru_tags",
        "related_danbooru_tags"
    ]);
    assert.ok(tools.RESOURCE_TOOLS.has("search_danbooru_tags"));
    assert.ok(tools.RESOURCE_TOOLS.has("inspect_danbooru_tags"));
    assert.ok(tools.RESOURCE_TOOLS.has("related_danbooru_tags"));
});

test("batch Danbooru search forwards all queries", async () => {
    const originalFetch = global.fetch;
    let requested;
    global.fetch = async (url) => {
        requested = url;
        return { ok: true, json: async () => ({ ok: true, items: [] }) };
    };
    try {
        await tools.searchDanbooruTagsTool({ queries: ["blue hair", "long hair"] });
    } finally {
        global.fetch = originalFetch;
    }
    const url = new URL(requested, window.location.origin);
    assert.equal(url.pathname, "/prompt-agent/api/danbooru/tags/search");
    assert.deepEqual(JSON.parse(url.searchParams.get("queries")), ["blue hair", "long hair"]);
    assert.equal(url.searchParams.get("query"), null);
});

test("resource mutation guard depends on the latest prompt context, not a second user confirmation", () => {
    window.__SD_FORGE_NEO_PROMPT_AGENT__.assistantState.promptReads.txt2img = { context_hash: "ctx" };
    assert.equal(tools.resourceMutationGuard({ target: "txt2img", context_hash: "ctx" }).ok, true);
});
