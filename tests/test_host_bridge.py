from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
class HostBridgeTests(unittest.TestCase):
    def test_boot_waits_for_forge_ui_and_retries_late_svelte_bundle(self):
        root = Path(__file__).resolve().parents[1]
        source = root / "javascript" / "prompt_agent_99_boot.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
let uiLoaded;
let mounted = 0;
let nextTimer = 1;
const timers = new Map();
global.document = {
  body: { appendChild: () => {} },
  createElement: () => ({ style: {}, append: () => {}, remove: () => {}, querySelector: () => ({}) }),
  getElementById: () => null,
};
global.window = {
  addEventListener: () => {},
  onUiLoaded: (callback) => { uiLoaded = callback; },
  setTimeout: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
  __SD_FORGE_NEO_PROMPT_AGENT__: {},
};
vm.runInThisContext(fs.readFileSync(process.argv.at(-1), "utf8"));
const first = timers.values().next().value;
timers.clear();
first();
window.__SD_FORGE_NEO_PROMPT_AGENT__.ui = { UI_READY: true, mountSvelteUi: () => { mounted += 1; } };
const second = timers.values().next().value;
timers.clear();
second();
if (mounted !== 0) throw new Error("mounted before Forge UI loaded");
uiLoaded();
if (mounted !== 1) throw new Error(`expected one mount, got ${mounted}`);
process.stdout.write("ok");
'''
        completed = subprocess.run(
            [shutil.which("node"), "-", str(source)],
            input=script,
            text=True,
            capture_output=True,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertEqual("ok", completed.stdout)

    def test_boot_mounts_when_loaded_after_the_forge_ui_event(self):
        root = Path(__file__).resolve().parents[1]
        source = root / "javascript" / "prompt_agent_99_boot.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
let mounted = 0;
let registered = 0;
global.document = {
  body: { appendChild: () => {} },
  querySelector: (selector) => selector === "#txt2img_prompt" ? { id: "txt2img_prompt" } : null,
  createElement: () => ({ style: {}, append: () => {}, remove: () => {}, querySelector: () => ({}) }),
  getElementById: () => null,
};
global.window = {
  addEventListener: () => {},
  onUiLoaded: () => { registered += 1; },
  setTimeout: () => { throw new Error("late boot should mount without polling"); },
  __SD_FORGE_NEO_PROMPT_AGENT__: { ui: { UI_READY: true, mountSvelteUi: () => { mounted += 1; } } },
};
vm.runInThisContext(fs.readFileSync(process.argv.at(-1), "utf8"));
if (registered !== 1) throw new Error(`expected lifecycle registration, got ${registered}`);
if (mounted !== 1) throw new Error(`expected one late mount, got ${mounted}`);
process.stdout.write("ok");
'''
        completed = subprocess.run(
            [shutil.which("node"), "-", str(source)],
            input=script,
            text=True,
            capture_output=True,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertEqual("ok", completed.stdout)

    def test_i18n_does_not_preload_unused_bundles(self):
        root = Path(__file__).resolve().parents[1]
        source = root / "javascript" / "prompt_agent_01_i18n.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
let fetches = 0;
global.window = { __SD_FORGE_NEO_PROMPT_AGENT__: {}, addEventListener: () => {}, dispatchEvent: () => {} };
global.navigator = { languages: ["en"] };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.fetch = async () => { fetches += 1; return { ok: true, json: async () => ({}) }; };
vm.runInThisContext(fs.readFileSync(process.argv.at(-1), "utf8"));
setTimeout(() => process.stdout.write(String(fetches)), 0);
'''
        completed = subprocess.run(
            [shutil.which("node"), "-", str(source)],
            input=script,
            text=True,
            capture_output=True,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertEqual("0", completed.stdout)

    def test_replace_rejects_ambiguous_allow_multiple_flag(self):
        root = Path(__file__).resolve().parents[1]
        source = root / "javascript" / "prompt_agent.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
global.window = { __SD_FORGE_NEO_PROMPT_AGENT__: {} };
global.document = { body: {}, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null };
vm.runInThisContext(fs.readFileSync(process.argv.at(-1), "utf8"));
const result = window.__SD_FORGE_NEO_PROMPT_AGENT__.applyPromptPatchText("x x", { operation: "replace", find: "x", replace: "y", allow_multiple: true });
process.stdout.write(JSON.stringify(result));
'''
        completed = subprocess.run(
            [shutil.which("node"), "-", str(source)],
            input=script,
            text=True,
            capture_output=True,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertFalse(result["ok"])
        self.assertIn("replace_all", result["error"])

    def test_core_publishes_versioned_host_api_without_replacing_exports(self):
        root = Path(__file__).resolve().parents[1]
        source = root / "javascript" / "prompt_agent.js"
        host_source = root / "javascript" / "prompt_agent_07_host.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
global.window = { __SD_FORGE_NEO_PROMPT_AGENT__: {} };
global.document = { body: {}, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null };
global.fetch = async () => ({ ok: true, json: async () => ({}) });
const [sourcePath, hostSourcePath] = process.argv.slice(-2);
vm.runInThisContext(fs.readFileSync(sourcePath, "utf8"), { filename: sourcePath });
const core = window.__SD_FORGE_NEO_PROMPT_AGENT__;
core.promptAgentMainApp = () => null;
core.activePromptTarget = () => "txt2img";
core.readPromptTool = async () => ({ ok: true });
core.captureForgeUiState = () => ({ controls: [] });
core.restoreForgeUiState = () => true;
core.executeAssistantTool = async () => ({ ok: true });
vm.runInThisContext(fs.readFileSync(hostSourcePath, "utf8"), { filename: hostSourcePath });
const host = core.hostApi;
process.stdout.write(JSON.stringify({
  name: host.name,
  version: host.version,
  apiVersion: host.apiVersion,
  capabilities: host.capabilities,
  prompt: host.activePromptTarget(),
  handshake: host.handshake({ client: "prompt-agent-ui", apiVersion: 1 }),
  hasCore: typeof core.readPromptTool === "function",
  fakeBridge: Object.hasOwn(core, "svelteUiBridge"),
  legacyNamespace: Object.hasOwn(window, "kohakuLoom") || Object.hasOwn(window, "KohakuLoomSvelteUi")
}));
'''
        completed = subprocess.run(
            [shutil.which("node"), "-", str(source), str(host_source)],
            input=script,
            text=True,
            capture_output=True,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual("prompt-agent-host", result["name"])
        self.assertEqual("1.0.0", result["version"])
        self.assertEqual(1, result["apiVersion"])
        self.assertIn("forge-state", result["capabilities"])
        self.assertEqual("txt2img", result["prompt"])
        self.assertTrue(result["handshake"]["ok"])
        self.assertEqual("prompt-agent-ui", result["handshake"]["bridge"])
        self.assertTrue(result["hasCore"])
        self.assertFalse(result["fakeBridge"])
        self.assertFalse(result["legacyNamespace"])

    def test_browser_host_revalidates_prompt_tools_before_dom_execution(self):
        root = Path(__file__).resolve().parents[1]
        source = root / "javascript" / "prompt_agent.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
const calls = [];
global.window = { __SD_FORGE_NEO_PROMPT_AGENT__: {} };
global.document = { body: {}, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null };
global.fetch = async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) });
  return { ok: true, json: async () => ({ ok: true, tool: "read_prompt", arguments: { target: "txt2img", field: "positive" } }) };
};
vm.runInThisContext(fs.readFileSync(process.argv.at(-1), "utf8"));
window.__SD_FORGE_NEO_PROMPT_AGENT__.readPromptTool = async (target) => ({ ok: true, target });
window.__SD_FORGE_NEO_PROMPT_AGENT__.executeAssistantTool({ tool: "read_prompt", arguments: { target: "txt2img", field: "positive" } }).then((result) => {
  process.stdout.write(JSON.stringify({ calls, result }));
});
'''
        completed = subprocess.run(
            [shutil.which("node"), "-", str(source)],
            input=script,
            text=True,
            capture_output=True,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual("/prompt-agent/api/forge-tools/validate", result["calls"][0]["url"])
        self.assertEqual("read_prompt", result["calls"][0]["body"]["tool"])
        self.assertEqual("txt2img", result["result"]["target"])

    def test_prompt_field_merge_preserves_guarded_overwrite_rules(self):
        root = Path(__file__).resolve().parents[1]
        source = root / "javascript" / "prompt_agent.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
class Textarea {
  constructor(value) { this.value = value; }
  dispatchEvent() {}
}
global.HTMLTextAreaElement = Textarea;
global.HTMLInputElement = class {};
global.HTMLSelectElement = class {};
global.Event = class { constructor(type) { this.type = type; } };
const positive = new Textarea("existing prompt");
const negative = new Textarea("");
const roots = {
  "#txt2img_prompt": { querySelector: () => positive },
  "#txt2img_neg_prompt": { querySelector: () => negative },
};
global.window = { __SD_FORGE_NEO_PROMPT_AGENT__: {} };
global.document = {
  body: {},
  getElementById: () => null,
  querySelectorAll: () => [],
  querySelector: (selector) => roots[selector] || null,
};
vm.runInThisContext(fs.readFileSync(process.argv.at(-1), "utf8"));
const tools = window.__SD_FORGE_NEO_PROMPT_AGENT__;
tools.assistantState.promptReads.txt2img = {
  positive: positive.value,
  negative: negative.value,
  positive_hash: tools.promptHash(positive.value),
  negative_hash: tools.promptHash(negative.value),
  context_hash: "ctx",
};
const rejected = tools.editPromptTool({
  target: "txt2img", field: "positive", base_hash: tools.promptHash(positive.value), prompt: "overwrite"
}, []);
const accepted = tools.editPromptTool({
  target: "txt2img", field: "negative", base_hash: tools.promptHash(negative.value), prompt: "low quality"
}, []);
process.stdout.write(JSON.stringify({ rejected, accepted, positive: positive.value, negative: negative.value }));
'''
        completed = subprocess.run(
            [shutil.which("node"), "-", str(source)],
            input=script,
            text=True,
            capture_output=True,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertFalse(result["rejected"]["ok"])
        self.assertIn("only when the current field is empty", result["rejected"]["error"])
        self.assertTrue(result["accepted"]["ok"])
        self.assertEqual("existing prompt", result["positive"])
        self.assertEqual("low quality", result["negative"])

if __name__ == "__main__":
    unittest.main()
