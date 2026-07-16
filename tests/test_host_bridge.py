from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
class HostBridgeTests(unittest.TestCase):
    def test_legacy_core_publishes_versioned_host_api_without_replacing_exports(self):
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
const legacy = window.kohakuLoom;
legacy.loomMainApp = () => null;
legacy.activePromptTarget = () => "txt2img";
legacy.readPromptTool = async () => ({ ok: true });
legacy.captureForgeUiState = () => ({ controls: [] });
legacy.restoreForgeUiState = () => true;
legacy.executeAssistantTool = async () => ({ ok: true });
legacy.claimAssistantToolBridge = async () => ({ owned: true });
legacy.profileStore = Object.fromEntries(["load", "current", "teacher", "session", "add", "duplicate", "update", "delete", "setActive", "setTeacher", "setSession", "setNaming", "restoreDefaults", "requestProjection"].map(name => [name, () => null]));
vm.runInThisContext(fs.readFileSync(hostSourcePath, "utf8"), { filename: hostSourcePath });
const host = legacy.hostApi;
process.stdout.write(JSON.stringify({
  name: host.name,
  version: host.version,
  apiVersion: host.apiVersion,
  capabilities: host.capabilities,
  prompt: host.activePromptTarget(),
  handshake: host.handshake({ client: "kohaku-loom-svelte-ui", apiVersion: 1 }),
  hasLegacy: typeof legacy.readPromptTool === "function",
  fakeBridge: Object.hasOwn(legacy, "svelteUiBridge")
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
        self.assertTrue(result["hasLegacy"])
        self.assertFalse(result["fakeBridge"])


if __name__ == "__main__":
    unittest.main()
