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
        source = root / "javascript" / "kohaku_loom_99_boot.js"
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
};
vm.runInThisContext(fs.readFileSync(process.argv.at(-1), "utf8"));
const first = timers.values().next().value;
timers.clear();
first();
window.KohakuLoomSvelteUi = { UI_READY: true, mountSvelteUi: () => { mounted += 1; } };
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
        source = root / "javascript" / "kohaku_loom_99_boot.js"
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
  KohakuLoomSvelteUi: { UI_READY: true, mountSvelteUi: () => { mounted += 1; } },
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

    def test_legacy_i18n_does_not_preload_unused_bundles(self):
        root = Path(__file__).resolve().parents[1]
        source = root / "javascript" / "kohaku_loom_01_i18n.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
let fetches = 0;
global.window = { kohakuLoom: {}, addEventListener: () => {}, dispatchEvent: () => {} };
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
        source = root / "javascript" / "kohaku_loom.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
global.window = { kohakuLoom: {} };
global.document = { body: {}, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null };
vm.runInThisContext(fs.readFileSync(process.argv.at(-1), "utf8"));
const result = window.kohakuLoom.applyPromptPatchText("x x", { operation: "replace", find: "x", replace: "y", allow_multiple: true });
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
        source = root / "javascript" / "kohaku_loom.js"
        host_source = root / "javascript" / "kohaku_loom_07_host.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
global.window = { kohakuLoom: {} };
global.document = { body: {}, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null };
global.fetch = async () => ({ ok: true, json: async () => ({}) });
const [sourcePath, hostSourcePath] = process.argv.slice(-2);
vm.runInThisContext(fs.readFileSync(sourcePath, "utf8"), { filename: sourcePath });
const core = window.kohakuLoom;
core.loomMainApp = () => null;
core.activePromptTarget = () => "txt2img";
core.readPromptTool = async () => ({ ok: true });
core.captureForgeUiState = () => ({ controls: [] });
core.restoreForgeUiState = () => true;
core.executeAssistantTool = async () => ({ ok: true });
core.claimAssistantToolBridge = async () => ({ owned: true });
core.profileStore = Object.fromEntries(["load", "current", "teacher", "session", "add", "duplicate", "update", "delete", "setActive", "setTeacher", "setSession", "setNaming", "restoreDefaults", "requestProjection"].map(name => [name, () => null]));
vm.runInThisContext(fs.readFileSync(hostSourcePath, "utf8"), { filename: hostSourcePath });
const host = core.hostApi;
process.stdout.write(JSON.stringify({
  name: host.name,
  version: host.version,
  apiVersion: host.apiVersion,
  capabilities: host.capabilities,
  prompt: host.activePromptTarget(),
  handshake: host.handshake({ client: "kohaku-loom-svelte-ui", apiVersion: 1 }),
  hasCore: typeof core.readPromptTool === "function",
  fakeBridge: Object.hasOwn(core, "svelteUiBridge")
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
        self.assertEqual("kohaku-loom-host", result["name"])
        self.assertEqual("1.0.0", result["version"])
        self.assertEqual(1, result["apiVersion"])
        self.assertIn("forge-state", result["capabilities"])
        self.assertEqual("txt2img", result["prompt"])
        self.assertTrue(result["handshake"]["ok"])
        self.assertTrue(result["hasCore"])
        self.assertFalse(result["fakeBridge"])

    def test_profile_import_retries_a_transient_startup_503(self):
        root = Path(__file__).resolve().parents[1]
        source = root / "javascript" / "kohaku_loom.js"
        host_source = root / "javascript" / "kohaku_loom_07_host.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
global.window = { kohakuLoom: {} };
global.localStorage = { removeItem: () => {} };
let calls = 0;
global.fetch = async (_url, options = {}) => {
  calls += 1;
  if (!options.method) return { ok: true, status: 200, json: async () => ({ profiles: [] }) };
  if (calls === 2) return { ok: false, status: 503, text: async () => '{"detail":"starting"}' };
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
const [sourcePath, hostSourcePath] = process.argv.slice(-2);
vm.runInThisContext(fs.readFileSync(sourcePath, "utf8"), { filename: sourcePath });
const core = window.kohakuLoom;
core.profileStore = { load: () => ({ profiles: [] }) };
vm.runInThisContext(fs.readFileSync(hostSourcePath, "utf8"), { filename: hostSourcePath });
core.hostApi.syncProfiles().then(() => process.stdout.write(String(calls))).catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
''';
        completed = subprocess.run(
            [shutil.which("node"), "-", str(source), str(host_source)],
            input=script,
            text=True,
            capture_output=True,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertEqual("3", completed.stdout)

    def test_first_profile_sync_restores_sidecar_state_before_browser_defaults_can_overwrite_it(self):
        root = Path(__file__).resolve().parents[1]
        host_source = root / "javascript" / "kohaku_loom_07_host.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
const calls = [];
let browserState = { profiles: [{ id: "gemini", has_api_key: false }] };
global.window = { kohakuLoom: {
  profileStore: {
    load: () => browserState,
    save: (state) => { browserState = state; calls.push("save"); return state; },
    scrubApiKeys: () => { calls.push("scrub"); return browserState; },
  },
} };
global.localStorage = { removeItem: () => {} };
global.fetch = async (url, options = {}) => {
  calls.push(options.method || "GET");
  if (options.method === "POST") throw new Error("startup must not overwrite persisted profiles");
  return { ok: true, status: 200, json: async () => ({
    active_profile_id: "custom",
    teacher_profile_id: "custom",
    session_profile_id: "",
    naming_profile_id: "",
    profiles: [{ id: "custom", profile_id: "custom", enabled: true, runtime: "remote-http", protocol: "openai-chat-completions", endpoint: "https://example.com/v1", model_id: "model", has_api_key: true }],
  }) };
};
vm.runInThisContext(fs.readFileSync(process.argv.at(-1), "utf8"));
window.kohakuLoom.hostApi.syncProfiles().then((result) => process.stdout.write(JSON.stringify({ calls, result, browserState }))).catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
'''
        completed = subprocess.run(
            [shutil.which("node"), "-", str(host_source)],
            input=script,
            text=True,
            capture_output=True,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual(["GET", "save", "scrub"], result["calls"])
        self.assertEqual("custom", result["browserState"]["active_profile_id"])
        self.assertTrue(result["browserState"]["profiles"][0]["has_api_key"])

    def test_first_profile_sync_imports_a_pending_plaintext_key_instead_of_restoring_old_state(self):
        root = Path(__file__).resolve().parents[1]
        host_source = root / "javascript" / "kohaku_loom_07_host.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
let request = null;
const browserState = { profiles: [{ id: "custom", api_key: "new-secret", has_api_key: true }] };
global.window = { kohakuLoom: { profileStore: { load: () => browserState, scrubApiKeys: () => browserState } } };
global.localStorage = { removeItem: () => {} };
global.fetch = async (url, options = {}) => {
  request = { url, method: options.method || "GET", body: options.body || "" };
  return { ok: true, status: 200, json: async () => ({ profiles: [{ profile_id: "custom", has_api_key: true }] }) };
};
vm.runInThisContext(fs.readFileSync(process.argv.at(-1), "utf8"));
window.kohakuLoom.hostApi.syncProfiles().then(() => process.stdout.write(JSON.stringify(request))).catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
'''
        completed = subprocess.run(
            [shutil.which("node"), "-", str(host_source)],
            input=script,
            text=True,
            capture_output=True,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        request = json.loads(completed.stdout)
        self.assertEqual("POST", request["method"])
        self.assertTrue(request["url"].endswith("/profiles/import"))
        self.assertEqual("new-secret", json.loads(request["body"])["profiles"][0]["api_key"])

    def test_profile_restore_does_not_overwrite_a_key_entered_while_sidecar_is_starting(self):
        root = Path(__file__).resolve().parents[1]
        host_source = root / "javascript" / "kohaku_loom_07_host.js"
        script = r'''
const fs = require("fs");
const vm = require("vm");
let browserState = { profiles: [{ id: "custom", api_key: "", has_api_key: false }] };
let releaseGet;
const pendingGet = new Promise((resolve) => { releaseGet = resolve; });
const requests = [];
global.window = { kohakuLoom: { profileStore: {
  load: () => browserState,
  save: (state) => { browserState = state; return state; },
  scrubApiKeys: () => browserState,
} } };
global.localStorage = { removeItem: () => {} };
global.fetch = async (url, options = {}) => {
  requests.push({ url, method: options.method || "GET", body: options.body || "" });
  if (!options.method) return pendingGet;
  return { ok: true, status: 200, json: async () => ({ profiles: [{ profile_id: "custom", has_api_key: true }] }) };
};
vm.runInThisContext(fs.readFileSync(process.argv.at(-1), "utf8"));
const syncing = window.kohakuLoom.hostApi.syncProfiles();
browserState = { profiles: [{ id: "custom", api_key: "new-secret", has_api_key: true }] };
releaseGet({ ok: true, status: 200, json: async () => ({ profiles: [{ profile_id: "custom", has_api_key: false }] }) });
syncing.then(() => process.stdout.write(JSON.stringify(requests))).catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
'''
        completed = subprocess.run(
            [shutil.which("node"), "-", str(host_source)],
            input=script,
            text=True,
            capture_output=True,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        requests = json.loads(completed.stdout)
        self.assertEqual(["GET", "POST"], [request["method"] for request in requests])
        self.assertEqual("new-secret", json.loads(requests[1]["body"])["profiles"][0]["api_key"])


if __name__ == "__main__":
    unittest.main()
