const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

global.window = {
    location: { origin: "http://127.0.0.1:7860" },
    setTimeout,
    q3vlPromptTools: {
        assistantState: { messages: [], loadedPromptSkills: {}, promptReads: {} },
        currentCheckpoint: () => "Anima-Aesthetic-v1.safetensors",
        currentForgePreset: () => "anima",
        promptContextSnapshot: () => ({ context_hash: "ctx" }),
        promptFieldRootForTarget: () => ({ target: "txt2img", root: null }),
        q3vlApp: () => ({ querySelector: () => null, querySelectorAll: () => [] }),
        readPromptTool: async () => ({}),
        setNativeValueIfAvailable: () => true,
        setTextboxValue: () => true,
        styleSelectorValue: () => "",
        textboxValue: () => "",
        truncateAssistantText: (value, limit) => String(value).slice(0, limit)
    }
};

require(path.resolve(__dirname, "../javascript/qwen3vl_prompt_tools_02_resources.js"));
const tools = window.q3vlPromptTools;

test("appendFragment is idempotent", () => {
    assert.deepEqual(tools.appendFragment("base", "__artists__"), { value: "base, __artists__", changed: true });
    assert.deepEqual(tools.appendFragment("base, __artists__", "__artists__"), { value: "base, __artists__", changed: false });
});

test("Anima auto-detection uses the active Forge model", () => {
    assert.equal(tools.automaticPromptSkillName(), "anima_dit");
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
