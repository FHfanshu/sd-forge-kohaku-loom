import json
import unittest

from lib_qwen3vl_prompt_tools.assistant_workflow import (
    PromptToolHarness,
    assistant_user_requested_prompt_edit,
    build_prompt_edit_eval_payloads,
    normalize_assistant_tool_calls,
    prompt_edit_messages,
    prompt_hash,
    run_assistant_loop,
)


class AssistantWorkflowTests(unittest.TestCase):
    def test_prompt_hash_matches_frontend_shape(self):
        self.assertEqual(prompt_hash(""), "fnv1a:811c9dc5:0")
        self.assertEqual(prompt_hash("abc"), "fnv1a:1a47e90b:3")

    def test_normalize_tool_calls_parses_text_json(self):
        text = '```json\n{"tool":"read_prompt","arguments":{"target":"active"}}\n```'
        calls = normalize_assistant_tool_calls({"text": text})
        self.assertEqual([{"tool": "read_prompt", "arguments": {"target": "active"}}], calls)

    def test_normalize_tool_calls_accepts_style_template_reader(self):
        calls = normalize_assistant_tool_calls({"text": '{"tool":"read_style_template","arguments":{"target":"txt2img"}}'})
        self.assertEqual([{"tool": "read_style_template", "arguments": {"target": "txt2img"}}], calls)

    def test_prompt_tool_harness_applies_search_replace_diff(self):
        harness = PromptToolHarness("left character, right character")
        read = harness({"tool": "read_prompt", "arguments": {"target": "active"}})
        result = harness(
            {
                "tool": "edit_prompt",
                "arguments": {
                    "target": "active",
                    "base_hash": read["prompt_hash"],
                    "diff": "<<<<<<< SEARCH\nleft character\n=======\nright character\n>>>>>>> REPLACE",
                },
            }
        )
        self.assertTrue(result["ok"])
        self.assertEqual("right character, right character", harness.prompt)

    def test_run_assistant_loop_executes_prompt_tools_until_final_text(self):
        harness = PromptToolHarness("left character, right character")
        calls = []

        def chat_fn(payload):
            calls.append(payload)
            if len(calls) == 1:
                return {"text": "", "tool_calls": [{"tool": "read_prompt", "arguments": {"target": "active"}}]}
            if len(calls) == 2:
                base_hash = json.loads(payload["messages"][-1]["content"])["prompt_hash"]
                return {
                    "text": "",
                    "tool_calls": [
                        {
                            "tool": "edit_prompt",
                            "arguments": {
                                "target": "active",
                                "base_hash": base_hash,
                                "patches": [{"operation": "replace", "find": "left character", "replace": "front character"}],
                            },
                        }
                    ],
                }
            return {"text": "done", "tool_calls": []}

        result = run_assistant_loop({}, "把这个提示词里的 left character 改成 front character", harness, chat_fn=chat_fn)
        self.assertTrue(result["ok"])
        self.assertTrue(result["prompt_edited"])
        self.assertEqual("front character, right character", harness.prompt)
        self.assertEqual("done", result["text"])

    def test_run_assistant_loop_preserves_native_tool_exchange(self):
        captured = []

        def chat_fn(payload):
            captured.append(payload)
            if len(captured) == 1:
                return {"text": "", "tool_calls": [{"id": "call-read", "tool": "read_prompt", "arguments": {"target": "active"}}]}
            return {"text": "done", "tool_calls": []}

        result = run_assistant_loop({}, "读取当前提示词", PromptToolHarness("subject"), chat_fn=chat_fn)
        history = captured[1]["messages"]
        self.assertTrue(result["ok"])
        self.assertEqual("call-read", history[-2]["tool_calls"][0]["id"])
        self.assertEqual("tool", history[-1]["role"])
        self.assertEqual("call-read", history[-1]["tool_call_id"])

    def test_prompt_edit_eval_payloads_builds_local_and_deepseek_cases(self):
        messages = prompt_edit_messages("修改当前提示词")
        cases = build_prompt_edit_eval_payloads(
            {"backend": "moyuu", "endpoint": "https://moyuu.cc", "model": "gemini-3.1-pro-high"},
            messages,
            local_models=[{"name": "qwen-2b", "model_path": r"E:\models\qwen-2b.gguf"}],
        )
        self.assertEqual(["moyuu:gemini-3.1-pro-high", "qwen-2b", "deepseek:deepseek-v4-pro"], [item["case_name"] for item in cases])
        self.assertEqual("local-qwen-once", cases[1]["backend"])
        self.assertEqual("deepseek", cases[2]["backend"])

    def test_prompt_edit_detection_matches_chinese_direct_edit(self):
        self.assertTrue(assistant_user_requested_prompt_edit("给当前 prompt 加上眼镜"))
        self.assertFalse(assistant_user_requested_prompt_edit("这个 prompt 应该怎么改？"))


if __name__ == "__main__":
    unittest.main()
