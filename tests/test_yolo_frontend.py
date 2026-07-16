from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
class YoloFrontendTests(unittest.TestCase):
    def test_mode_isolation_and_stale_hash_reject_without_writes(self):
        root = Path(__file__).resolve().parents[1]
        source = root / "javascript" / "kohaku_loom_025_yolo.js"
        script = r"""
const fs = require("fs");
const vm = require("vm");

function hash(text) {
    let value = String(text || "");
    let result = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        result ^= value.charCodeAt(i);
        result = Math.imul(result, 16777619);
    }
    return `fnv1a:${(result >>> 0).toString(16).padStart(8, "0")}:${value.length}`;
}
function control(value, min = "", max = "") {
    return { value: String(value), min: String(min), max: String(max) };
}
function root(controlValue) {
    return {
        matches: () => false,
        querySelector: () => controlValue,
        querySelectorAll: () => []
    };
}

const controls = {
    positive: control("portrait"),
    negative: control("blurry"),
    "#txt2img_seed": control(-1, -1, 4294967295),
    "#txt2img_width": control(512, 64, 2048),
    "#txt2img_height": control(512, 64, 2048),
    "#txt2img_steps": control(20, 1, 150),
    "#txt2img_cfg_scale": control(7, 0, 30),
    "#txt2img_sampling": control("Euler"),
    "#txt2img_scheduler": control("Normal")
};
const roots = Object.fromEntries(Object.entries(controls).filter(([name]) => name.startsWith("#")).map(([name, item]) => [name, root(item)]));
const tools = {
    assistantState: { agentMode: "normal" },
    promptFieldRootForTarget: (_target, field) => ({ root: root(controls[field]) }),
    loomApp: () => ({ querySelector: selector => roots[selector] || null }),
    currentCheckpoint: () => "checkpoint.safetensors",
    currentForgePreset: () => "sdxl",
    promptHash: hash,
    applyPromptPatchText: (text, patch) => patch.operation === "append" ? { ok: true, text: text + patch.text } : { ok: false, error: "unsupported" },
    promptPatchResidue: () => [],
    positivePromptNoPhrases: () => [],
    setNativeValueIfAvailable: (target, value) => { target.value = String(value); return true; }
};
global.window = global;
global.fetch = async path => ({
    ok: true,
    status: 200,
    json: async () => path.includes("samplers") ? [{ name: "Euler", aliases: [] }] : [{ name: "normal", label: "Normal", aliases: [] }]
});
window.kohakuLoom = tools;
vm.runInThisContext(fs.readFileSync(process.argv[2], "utf8"), { filename: process.argv[2] });

(async () => {
    const normal = tools.readTxt2ImgStateTool();
    const issued = tools.readTxt2ImgStateTool({ _yolo_authorized: true });
    tools.assistantState.agentMode = "yolo";
    const read = tools.readTxt2ImgStateTool();
    controls["#txt2img_seed"].value = "123";
    const stale = await tools.applyTxt2ImgPatchTool({ state_hash: read.state_hash, changes: { width: 768 } });
    const reread = tools.readTxt2ImgStateTool();
    const applied = await tools.applyTxt2ImgPatchTool({
        state_hash: reread.state_hash,
        changes: {
            positive_prompt_patches: [{ operation: "append", text: ", rim light" }],
            width: 768,
            steps: 28
        }
    });
    process.stdout.write(JSON.stringify({
        normal,
        issued,
        read,
        stale,
        applied,
        positive: controls.positive.value,
        width: controls["#txt2img_width"].value,
        steps: controls["#txt2img_steps"].value,
        cachedRead: tools.assistantState.txt2imgStateRead
    }));
})().catch(error => { console.error(error); process.exit(1); });
"""
        completed = subprocess.run(
            [shutil.which("node"), "-", str(source)],
            input=script,
            text=True,
            capture_output=True,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertFalse(result["normal"]["ok"])
        self.assertEqual("YOLO mode is required", result["normal"]["error"])
        self.assertTrue(result["issued"]["ok"])
        self.assertTrue(result["read"]["ok"])
        self.assertFalse(result["stale"]["ok"])
        self.assertIn("state changed", result["stale"]["error"])
        self.assertTrue(result["applied"]["ok"])
        self.assertEqual(3, len(result["applied"]["changes"]))
        self.assertEqual("portrait, rim light", result["positive"])
        self.assertEqual("768", result["width"])
        self.assertEqual("28", result["steps"])
        self.assertEqual(result["applied"]["state_hash"], result["cachedRead"]["state_hash"])


if __name__ == "__main__":
    unittest.main()
