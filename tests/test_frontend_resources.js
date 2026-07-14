const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

global.window = {
    location: { origin: "http://127.0.0.1:7860" },
    setTimeout,
    kohakuLoom: {
        assistantState: { messages: [], loadedPromptSkills: {}, promptReads: {} },
        currentCheckpoint: () => "Anima-Aesthetic-v1.safetensors",
        currentForgePreset: () => "anima",
        promptContextSnapshot: () => ({ context_hash: "ctx" }),
        promptFieldRootForTarget: () => ({ target: "txt2img", root: null }),
        loomApp: () => ({ querySelector: () => null, querySelectorAll: () => [] }),
        readPromptTool: async () => ({}),
        positivePromptNoPhrases: () => [],
        setNativeValueIfAvailable: () => true,
        setTextboxValue: () => true,
        styleSelectorValue: () => "",
        textboxValue: () => "",
        truncateAssistantText: (value, limit) => String(value).slice(0, limit)
    }
};

require(path.resolve(__dirname, "../javascript/kohaku_loom_02_resources.js"));
const tools = window.kohakuLoom;

test("appendFragment is idempotent", () => {
    assert.deepEqual(tools.appendFragment("base", "__artists__"), { value: "base, __artists__", changed: true });
    assert.deepEqual(tools.appendFragment("base, __artists__", "__artists__"), { value: "base, __artists__", changed: false });
});

test("Anima auto-detection uses the active Forge model", () => {
    assert.equal(tools.automaticPromptSkillName(), "anima_dit");
});

test("Danbooru tools are registered for agent execution", () => {
    assert.ok(tools.RESOURCE_TOOLS.has("search_danbooru_tags"));
    assert.ok(tools.RESOURCE_TOOLS.has("inspect_danbooru_tag"));
    assert.ok(tools.RESOURCE_TOOLS.has("inspect_danbooru_tags"));
    assert.ok(tools.RESOURCE_TOOLS.has("related_danbooru_tags"));
});

test("tag requests load Danbooru rules alongside the active model guide", () => {
    assert.deepEqual(tools.automaticPromptSkillNames("create a Danbooru tag prompt"), ["anima_dit", "danbooru_tags"]);
});

test("tag requests are recognized for mandatory Danbooru preflight", () => {
    assert.equal(tools.isDanbooruTagRequest("给我一个 Danbooru 标签提示词"), true);
    assert.equal(tools.isDanbooruTagRequest("write a direct natural language prompt"), false);
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
    assert.deepEqual(JSON.parse(url.searchParams.get("queries")), ["blue hair", "long hair"]);
    assert.equal(url.searchParams.get("query"), null);
});

test("resource mutation guard depends on the latest prompt context, not a second user confirmation", () => {
    window.kohakuLoom.assistantState.promptReads.txt2img = { context_hash: "ctx" };
    assert.equal(tools.resourceMutationGuard({ target: "txt2img", context_hash: "ctx" }).ok, true);
});

test("message compaction keeps the first user goal and recent messages", () => {
    const messages = [{ role: "user", content: "original goal" }];
    for (let index = 0; index < 30; index += 1) messages.push({ role: "user", content: `Tool result for x: ${"x".repeat(4000)}` });
    const compacted = tools.compactAssistantMessages(messages, 1000);
    assert.equal(compacted[0].content, "original goal");
    assert.ok(compacted.length <= 13);
    assert.ok(compacted.at(-1).content.length <= 1600);
});

test("message compaction enforces its total payload budget for long chat text", () => {
    const messages = [
        { role: "user", content: "original goal" },
        { role: "assistant", content: "a".repeat(120000) },
        { role: "user", content: "latest request" }
    ];
    const compacted = tools.compactAssistantMessages(messages, 16000);
    assert.equal(compacted[0].content, "original goal");
    assert.ok(JSON.stringify(compacted).length <= 16000);
});
