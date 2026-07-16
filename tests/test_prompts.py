import unittest
from unittest.mock import MagicMock, Mock, patch

from kohaku_loom.assistant import _prompt_assistant_chat_once, ask_teacher, prompt_assistant_chat
from kohaku_loom.assistant_common import _assistant_request_messages
from kohaku_loom.constants import DEFAULT_ASSISTANT_BACKEND, DEFAULT_ASSISTANT_MODEL
from kohaku_loom.generic import _PromptSanitizer, _restore_gemini_result
from kohaku_loom.assistant_gemini import _assistant_use_gemini_native, _gemini_request_body, _gemini_sdk_contents, _gemini_tools, _prompt_assistant_chat_gemini
from kohaku_loom.assistant_teacher import qwen_teacher_enabled


class PromptToolsTests(unittest.TestCase):
    def test_prompt_sanitizer_restores_tool_arguments(self):
        sanitizer = _PromptSanitizer(True)
        sanitized = sanitizer.sanitize_text("moqing, erection, precum")
        self.assertIn("SAFE_SLOT_001", sanitized)
        self.assertNotIn("erection", sanitized)

        result = {
            "text": "",
            "tool_calls": [
                {
                    "tool": "edit_prompt",
                    "arguments": {
                        "diff": "<<<<<<< SEARCH\nmoqing, SAFE_SLOT_001, SAFE_SLOT_002\n=======\nmoqing, glasses, SAFE_SLOT_001, SAFE_SLOT_002\n>>>>>>> REPLACE"
                    },
                }
            ],
        }
        restored = _restore_gemini_result(result, sanitizer)
        diff = restored["tool_calls"][0]["arguments"]["diff"]
        self.assertIn("erection", diff)
        self.assertIn("precum", diff)
        self.assertNotIn("SAFE_SLOT", diff)
        self.assertEqual(restored["sanitized_slots"], 2)

    def test_regex_teacher_mode_disables_qwen_preprocess(self):
        self.assertFalse(qwen_teacher_enabled({"teacher_mode": "regex"}))

    def test_gemini_chat_uses_teacher_preprocessor(self):
        payload = {"messages": [{"role": "user", "content": "nude SAFE_SLOT_001"}], "teacher_mode": "qwen-redact"}
        with patch(
            "kohaku_loom.assistant_gemini.prepare_teacher_messages",
            return_value=([{"role": "user", "content": "teacher safe briefing SAFE_SLOT_001"}], {"teacher_mode": "local-qwen-redact", "teacher_model": "qwen"}),
        ) as prepare, patch(
            "kohaku_loom.assistant_gemini._gemini_post_generate",
            return_value={"text": "ok", "tool_calls": []},
        ) as post:
            result = _prompt_assistant_chat_gemini(payload, "https://moyuu.cc", "gemini-3.1-pro-high", "test-key")

        prepare.assert_called_once()
        body = post.call_args.args[3]
        self.assertEqual(body["contents"][0]["parts"][0]["text"], "teacher safe briefing SAFE_SLOT_001")
        self.assertEqual(result["teacher_mode"], "local-qwen-redact")
        self.assertEqual(result["teacher_model"], "qwen")

    def test_gemini_body_can_disable_tools_for_teacher(self):
        body, _tokens = _gemini_request_body({"disable_tools": True}, [{"role": "user", "content": "teacher only"}])
        self.assertNotIn("tools", body)
        self.assertNotIn("toolConfig", body)
        self.assertIn("Tools are disabled", body["systemInstruction"]["parts"][0]["text"])
        self.assertEqual({"thinkingLevel": "LOW"}, body["generationConfig"]["thinkingConfig"])

    def test_gemini_danbooru_search_schema_is_relay_compatible(self):
        declarations = _gemini_tools()[0]["functionDeclarations"]
        search = next(item for item in declarations if item["name"] == "search_danbooru_tags")
        self.assertEqual(["queries"], search["parameters"]["required"])
        self.assertNotIn("anyOf", search["parameters"])
        self.assertNotIn("query", search["parameters"]["properties"])

    def test_gemini_redacted_output_keeps_safe_slots(self):
        from kohaku_loom.assistant_gemini import _redact_gemini_result

        result = _redact_gemini_result({"text": "nude character with penis", "tool_calls": []})
        self.assertNotIn("nude", result["text"])
        self.assertNotIn("penis", result["text"])
        self.assertIn("SAFE_SLOT_001", result["text"])

    def test_gemini_reasoning_effort_maps_to_native_thinking_level(self):
        high, _tokens = _gemini_request_body({"reasoning_effort": "high"}, [{"role": "user", "content": "hello"}])
        maximum, _tokens = _gemini_request_body({"reasoning_effort": "max"}, [{"role": "user", "content": "hello"}])
        self.assertEqual({"thinkingLevel": "HIGH"}, high["generationConfig"]["thinkingConfig"])
        self.assertEqual({"thinkingLevel": "HIGH"}, maximum["generationConfig"]["thinkingConfig"])

    def test_gemini_sdk_contents_preserve_inline_image_bytes(self):
        contents = _gemini_sdk_contents(
            {
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {"text": "describe this"},
                            {"inlineData": {"mimeType": "image/png", "data": "QUFBQQ=="}},
                        ],
                    }
                ]
            }
        )
        self.assertEqual("describe this", contents[0].parts[0].text)
        self.assertEqual(b"AAAA", contents[0].parts[1].inline_data.data)
        self.assertEqual("image/png", contents[0].parts[1].inline_data.mime_type)

    def test_openai_messages_preserve_native_image_attachment(self):
        messages = _assistant_request_messages(
            [{"role": "user", "content": "describe this", "image": "data:image/png;base64,AAAA"}]
        )
        self.assertEqual("text", messages[1]["content"][0]["type"])
        self.assertEqual("image_url", messages[1]["content"][1]["type"])
        self.assertEqual("data:image/png;base64,AAAA", messages[1]["content"][1]["image_url"]["url"])

    def test_openai_messages_preserve_native_tool_exchange(self):
        messages = _assistant_request_messages([
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "call-1", "tool": "read_prompt", "arguments": {"target": "active"}}],
            },
            {"role": "tool", "tool_call_id": "call-1", "content": '{"ok":true}'},
        ])
        self.assertEqual("call-1", messages[1]["tool_calls"][0]["id"])
        self.assertEqual("read_prompt", messages[1]["tool_calls"][0]["function"]["name"])
        self.assertEqual("tool", messages[2]["role"])
        self.assertEqual("call-1", messages[2]["tool_call_id"])

    def test_openai_messages_drop_orphaned_tool_result(self):
        messages = _assistant_request_messages([
            {"role": "user", "content": "hello"},
            {"role": "tool", "tool_call_id": "missing", "content": '{"ok":true}'},
        ])
        self.assertEqual(["system", "user"], [message["role"] for message in messages])

    def test_session_context_preserves_summary_and_selected_window(self):
        history = [{"role": "system", "content": "Durable session summary"}] + [
            {"role": "user", "content": f"turn {index}"} for index in range(24)
        ]
        messages = _assistant_request_messages(history, preserve_window=True)
        self.assertEqual("Durable session summary", messages[1]["content"])
        self.assertEqual("turn 23", messages[-1]["content"])
        self.assertEqual(26, len(messages))

    def test_gemini_messages_keep_structured_tool_exchange(self):
        from kohaku_loom.assistant_gemini import _gemini_contents

        contents, _tokens = _gemini_contents([
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call-1", "tool": "read_prompt"}]},
            {"role": "tool", "tool_call_id": "call-1", "content": "Tool result for read_prompt: ok"},
        ])
        self.assertEqual("model", contents[0]["role"])
        self.assertEqual({"id": "call-1", "name": "read_prompt", "args": {}}, contents[0]["parts"][0]["functionCall"])
        self.assertEqual("tool", contents[1]["role"])
        self.assertEqual({"id": "call-1", "name": "read_prompt", "response": {"result": "Tool result for read_prompt: ok"}}, contents[1]["parts"][0]["functionResponse"])

    def test_openai_body_can_disable_tools_for_convergence(self):
        response = Mock()
        response.model_dump.return_value = {"choices": [{"message": {"content": "hello"}}]}
        client = MagicMock()
        client.__enter__.return_value.chat.completions.create.return_value = response
        with patch("kohaku_loom.assistant_openai._openai_client", return_value=client):
            result = _prompt_assistant_chat_once(
                {
                    "backend": "openai",
                    "endpoint": "https://example.com/v1",
                    "model": "test-model",
                    "messages": [{"role": "user", "content": "hello"}],
                    "disable_tools": True,
                }
            )

        body = client.__enter__.return_value.chat.completions.create.call_args.kwargs
        self.assertNotIn("tools", body)
        self.assertNotIn("tool_choice", body)
        self.assertIn("Tools are disabled", body["messages"][0]["content"])
        self.assertEqual("hello", result["text"])

    def test_openai_backend_can_force_moyuu_compatible_route(self):
        self.assertFalse(_assistant_use_gemini_native("openai", "https://moyuu.cc", "grok-4.5"))
        self.assertTrue(_assistant_use_gemini_native("moyuu", "https://moyuu.cc", "gemini-3.5-flash-high"))

    def test_default_legacy_route_uses_portable_local_endpoint(self):
        self.assertEqual("local-lmcpp", DEFAULT_ASSISTANT_BACKEND)
        self.assertEqual("local-model", DEFAULT_ASSISTANT_MODEL)

    def test_chat_does_not_retry_with_another_model(self):
        payload = {
            "backend": "moyuu",
            "endpoint": "https://moyuu.cc",
            "model": "gemini-3.5-flash-preview",
            "api_key": "same-moyuu-key",
            "messages": [{"role": "user", "content": "hello"}],
        }
        with patch("kohaku_loom.assistant._prompt_assistant_chat_once", side_effect=RuntimeError("gemini unavailable")) as chat:
            with self.assertRaisesRegex(RuntimeError, "gemini unavailable"):
                prompt_assistant_chat(payload)
        chat.assert_called_once_with(payload)

    def test_ask_teacher_uses_gemini_without_tools(self):
        with patch(
            "kohaku_loom.assistant._dispatch_assistant_chat",
            return_value={"text": "teacher advice", "model": "gemini-3.1-pro-high", "endpoint": "https://moyuu.cc", "teacher_mode": "regex"},
        ) as chat:
            result = ask_teacher({"question": "How should I improve this?", "context": "SAFE_SLOT_001 composition", "api_key": "test-key"})

        teacher_payload = chat.call_args.args[0]
        self.assertTrue(teacher_payload["disable_tools"])
        self.assertEqual(teacher_payload["teacher_mode"], "regex")
        self.assertIn("SAFE_SLOT_001", teacher_payload["messages"][0]["content"])
        self.assertEqual(result["text"], "teacher advice")


if __name__ == "__main__":
    unittest.main()
