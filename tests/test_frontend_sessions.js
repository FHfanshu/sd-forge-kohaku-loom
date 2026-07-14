const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const modulePath = path.resolve(__dirname, "../javascript/qwen3vl_prompt_tools_sessions.js");

function loadModule() {
    delete require.cache[modulePath];
    global.window = { q3vlPromptTools: { assistantState: {} } };
    global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    require(modulePath);
    return window.q3vlPromptTools;
}

test("session history search path encodes the query", () => {
    const tools = loadModule();
    assert.equal(tools.assistantSessionListPath(""), "/sessions?limit=30");
    assert.equal(tools.assistantSessionListPath("red hair & sky"), "/sessions?limit=30&query=red%20hair%20%26%20sky");
});
