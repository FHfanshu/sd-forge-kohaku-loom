const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

global.window = {
    location: { href: "http://127.0.0.1:7860" },
    q3vlPromptTools: {}
};

require(path.resolve(__dirname, "../javascript/qwen3vl_prompt_tools_assistant.js"));
const tools = window.q3vlPromptTools;

test("repeated tools converge before a high-confidence loop stop", () => {
    assert.equal(tools.assistantRepeatedToolAction("read_prompt", 1), "execute");
    assert.equal(tools.assistantRepeatedToolAction("read_prompt", 4), "converge");
    assert.equal(tools.assistantRepeatedToolAction("read_prompt", 5), "execute");
    assert.equal(tools.assistantRepeatedToolAction("read_prompt", 6), "stop");
});

test("retries of mutating tools are not killed immediately", () => {
    assert.equal(tools.assistantRepeatedToolAction("edit_prompt", 2), "execute");
    assert.equal(tools.assistantRepeatedToolAction("apply_resource", 4), "converge");
});

test("new prompt writing requests require a UI edit", () => {
    assert.equal(tools.assistantUserRequestedPromptEdit("帮我编写一份海边女孩的提示词"), true);
    assert.equal(tools.assistantUserRequestedPromptEdit("Generate a portrait prompt for me"), true);
    assert.equal(tools.assistantUserRequestedPromptEdit("提示词应该怎么写？"), false);
});

test("profile vision capability controls native image attachments", () => {
    assert.equal(tools.assistantSupportsNativeImages({ model: "arbitrary", capabilities: { vision: true } }), true);
    assert.equal(tools.assistantSupportsNativeImages({ model: "gemini-named", capabilities: { vision: false } }), false);
});

test("Grok attachments are delegated to Gemini vision", () => {
    assert.equal(tools.assistantUsesGeminiVisionDelegate({ model: "grok-4.5" }), true);
    assert.equal(tools.assistantUsesGeminiVisionDelegate({ model: "gemini-3.1-pro-high" }), false);
});

test("prompt skill loading is not exposed as a model tool", () => {
    assert.deepEqual(tools.parseAssistantTools("Use load_prompt_skill when an Anima guide is needed."), []);
    assert.deepEqual(tools.parseAssistantTools('load_prompt_skill {"name":"anima_dit"}'), []);
});

test("native tool call ids survive browser normalization", () => {
    assert.deepEqual(
        tools.normalizeAssistantToolCall({ id: "call-7", function: { name: "read_prompt", arguments: '{"target":"active"}' } }),
        { id: "call-7", tool: "read_prompt", arguments: { target: "active" } }
    );
});
