const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const corePath = path.resolve(__dirname, "../javascript/prompt_agent.js");

function loadCore() {
    delete require.cache[corePath];
    global.document = {
        body: {},
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };
    global.window = { __SD_FORGE_NEO_PROMPT_AGENT__: {} };
    require(corePath);
    return window.__SD_FORGE_NEO_PROMPT_AGENT__;
}

test("positive prompt guard detects no-phrase exclusions", () => {
    const tools = loadCore();
    assert.equal(typeof tools.promptAgentApp, "function");
    assert.equal(typeof tools.promptAgentMainApp, "function");
    assert.equal(Object.hasOwn(window, "kohakuLoom"), false);
    assert.deepEqual(tools.positivePromptNoPhrases("portrait, no hat, no background"), ["no hat", "no background"]);
    assert.deepEqual(tools.positivePromptNoPhrases("portrait, noir lighting"), []);
});

test("active prompt target uses stable tab identity instead of localized text", () => {
    const tools = loadCore();
    const selected = {
        id: "",
        textContent: "图生图",
        classList: { contains: () => false },
        getAttribute(name) {
            return name === "aria-selected" ? "true" : name === "aria-controls" ? "img2img-interface" : null;
        }
    };
    const tabs = { querySelectorAll: () => [selected] };
    global.document.querySelector = (selector) => selector === "#tabs" ? tabs : null;
    assert.equal(tools.activePromptTarget(), "img2img");
});

test("replace_n scans the original prompt and cannot replace its own output", () => {
    const tools = loadCore();
    assert.deepEqual(
        tools.applyPromptPatchText("a a", { operation: "replace_n", find: "a", replace: "aa", count: 2 }),
        { ok: true, text: "aa aa", changed: 2 }
    );
    assert.equal(tools.applyPromptPatchText("a", { operation: "replace_n", find: "a", replace: "aa", count: 1000000000 }).ok, false);
});
