import json
import unittest
from unittest.mock import MagicMock, Mock, patch

from lib_qwen3vl_prompt_tools.assistant import _assistant_api_key, ask_teacher, prompt_assistant_chat, prompt_assistant_stream
from lib_qwen3vl_prompt_tools.assistant_gemini import _gemini_base_url, _gemini_client, _gemini_response_parts, _gemini_url
from lib_qwen3vl_prompt_tools.assistant_openai import _openai_chat_url, _openai_result
from lib_qwen3vl_prompt_tools.assistant_profiles import normalize_assistant_payload, normalize_model_profile


def remote_profile(**overrides):
    payload = {
        "profile_id": "test-profile",
        "protocol": "openai-chat-completions",
        "runtime": "remote-http",
        "endpoint": "https://api.example.com/v1",
        "model": "test-model",
        "api_key": "test-key",
        "capabilities": ["text", "images", "tools"],
        "parameters": {"temperature": 0.2, "top_p": 0.8, "max_tokens": 1024, "timeout": 30},
        "messages": [{"role": "user", "content": "hello"}],
    }
    payload.update(overrides)
    return payload


def sdk_value(data):
    value = Mock()
    value.model_dump.return_value = data
    return value


def sdk_client(result=None, error=None):
    client = MagicMock()
    create = client.__enter__.return_value.chat.completions.create
    if error is not None:
        create.side_effect = error
    else:
        create.return_value = result
    return client


def gemini_sdk_client(result=None, stream=None, error=None):
    client = MagicMock()
    models = client.__enter__.return_value.models
    if error is not None:
        models.generate_content.side_effect = error
        models.generate_content_stream.side_effect = error
    else:
        models.generate_content.return_value = result
        models.generate_content_stream.return_value = stream or []
    return client


class AssistantProfileTests(unittest.TestCase):
    def test_profile_validation_names_invalid_fields(self):
        with self.assertRaisesRegex(RuntimeError, "protocol"):
            normalize_model_profile(remote_profile(protocol="automatic"))
        with self.assertRaisesRegex(RuntimeError, "runtime"):
            normalize_model_profile(remote_profile(runtime="local"))
        with self.assertRaisesRegex(RuntimeError, "endpoint"):
            normalize_model_profile(remote_profile(endpoint=""))
        with self.assertRaisesRegex(RuntimeError, "max_tokens"):
            normalize_model_profile(remote_profile(parameters={"max_tokens": 0}))
        with self.assertRaisesRegex(RuntimeError, "fallback_endpoints"):
            normalize_model_profile(remote_profile(fallback_endpoints="https://fallback.example.com"))

    def test_llama_once_requires_model_path(self):
        payload = remote_profile(
            protocol="openai-chat-completions",
            runtime="llama-once",
            endpoint="",
            model="local-model",
        )
        with self.assertRaisesRegex(RuntimeError, "model_path"):
            normalize_model_profile(payload)

    def test_new_profile_does_not_infer_protocol_from_model_or_domain(self):
        payload = remote_profile(
            protocol="openai-chat-completions",
            endpoint="https://moyuu.cc",
            model="gemini-3.5-flash-preview",
            parameters={"timeout": 30},
        )
        with patch(
            "lib_qwen3vl_prompt_tools.assistant._prompt_assistant_chat_openai",
            return_value={"text": "openai", "tool_calls": []},
        ) as openai_chat, patch(
            "lib_qwen3vl_prompt_tools.assistant._prompt_assistant_chat_gemini"
        ) as gemini_chat:
            result = prompt_assistant_chat(payload)
        self.assertEqual("openai", result["text"])
        openai_chat.assert_called_once()
        gemini_chat.assert_not_called()

    def test_explicit_profile_does_not_inherit_environment_api_keys(self):
        payload = normalize_assistant_payload(remote_profile(api_key=""))
        with patch.dict(
            "os.environ",
            {"OPENAI_API_KEY": "openai-secret", "MOYUU_API_KEY": "moyuu-secret"},
            clear=True,
        ):
            self.assertEqual("", _assistant_api_key(payload))

    def test_legacy_payload_can_still_use_environment_api_key(self):
        payload = normalize_assistant_payload(
            {"backend": "openai", "messages": [{"role": "user", "content": "hi"}]}
        )
        with patch.dict("os.environ", {"OPENAI_API_KEY": "legacy-secret"}, clear=True):
            self.assertEqual("legacy-secret", _assistant_api_key(payload))

    def test_legacy_local_endpoint_does_not_inherit_environment_api_key(self):
        payload = normalize_assistant_payload(
            {"backend": "local-lmcpp", "messages": [{"role": "user", "content": "hi"}]}
        )
        with patch.dict(
            "os.environ",
            {"OPENAI_API_KEY": "openai-secret", "MOYUU_API_KEY": "moyuu-secret"},
            clear=True,
        ):
            self.assertEqual("", _assistant_api_key(payload))

    def test_profile_ignores_legacy_fallback_endpoint(self):
        normalized = normalize_model_profile(
            remote_profile(fallback_endpoint="https://legacy.example.com", fallback_endpoints=[])
        )
        self.assertEqual([], normalized["fallback_endpoints"])

    def test_legacy_payload_normalizes_singular_fallback_once(self):
        normalized = normalize_assistant_payload(
            {
                "backend": "moyuu",
                "endpoint": "https://primary.example.com",
                "model": "gemini-test",
                "fallback_endpoint": "https://one.example.com, https://two.example.com",
                "messages": [],
            }
        )
        self.assertEqual("gemini-native", normalized["protocol"])
        self.assertEqual(
            ["https://one.example.com", "https://two.example.com"],
            normalized["fallback_endpoints"],
        )

    def test_protocol_urls_are_owned_by_adapters(self):
        self.assertEqual(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
            _gemini_url("https://generativelanguage.googleapis.com", "gemini-2.5-flash"),
        )
        self.assertEqual(
            "https://api.example.com/v1/chat/completions",
            _openai_chat_url("https://api.example.com/v1"),
        )

    def test_gemini_sdk_base_url_accepts_root_versioned_and_legacy_action_endpoints(self):
        self.assertEqual("https://relay.example.com", _gemini_base_url("https://relay.example.com"))
        self.assertEqual("https://relay.example.com", _gemini_base_url("https://relay.example.com/v1beta"))
        self.assertEqual(
            "https://relay.example.com",
            _gemini_base_url("https://relay.example.com/v1beta/models/gemini-test:generateContent"),
        )

    def test_gemini_sdk_client_configures_relay_endpoint_timeout_and_bearer_auth(self):
        with patch("lib_qwen3vl_prompt_tools.assistant_gemini.genai.Client") as factory:
            _gemini_client("https://relay.example.com/v1beta", "sk-test", 30)
        options = factory.call_args.kwargs["http_options"]
        self.assertEqual("sk-test", factory.call_args.kwargs["api_key"])
        self.assertEqual("https://relay.example.com", options.base_url)
        self.assertEqual({"Authorization": "Bearer sk-test"}, options.headers)
        self.assertEqual(30000, options.timeout)

    def test_explicit_deepseek_profile_keeps_reasoning_options(self):
        client = sdk_client(sdk_value({"choices": [{"message": {"content": "ok"}}]}))
        payload = remote_profile(endpoint="https://api.deepseek.com", model="deepseek-v4-pro")
        with patch("lib_qwen3vl_prompt_tools.assistant_openai._openai_client", return_value=client):
            self.assertEqual("ok", prompt_assistant_chat(payload)["text"])
        body = client.__enter__.return_value.chat.completions.create.call_args.kwargs
        self.assertEqual({"thinking": {"type": "enabled"}}, body["extra_body"])
        self.assertEqual("low", body["reasoning_effort"])

    def test_gemini_fallback_endpoints_are_tried_in_order(self):
        payload = remote_profile(
            protocol="gemini-native",
            endpoint="https://primary.example.com",
            fallback_endpoints=["https://first.example.com", "https://second.example.com"],
            parameters={"timeout": 30},
            teacher_mode="regex",
        )
        with patch(
            "lib_qwen3vl_prompt_tools.assistant_gemini._gemini_post_generate",
            side_effect=[RuntimeError("down"), RuntimeError("down"), {"text": "ok", "tool_calls": []}],
        ) as post:
            result = prompt_assistant_chat(payload)
        self.assertEqual("ok", result["text"])
        self.assertEqual(
            ["https://primary.example.com", "https://first.example.com", "https://second.example.com"],
            [call.args[0] for call in post.call_args_list],
        )
        self.assertTrue(all(call.args[1] == "test-model" for call in post.call_args_list))

    def test_gemini_stream_does_not_fallback_after_emitting_content(self):
        def broken_stream():
            yield sdk_value({"candidates": [{"content": {"parts": [{"text": "partial"}]}}]})
            raise OSError("stream lost")

        payload = remote_profile(
            protocol="gemini-native",
            fallback_endpoints=["https://fallback.example.com"],
            parameters={"timeout": 30},
            teacher_mode="regex",
        )
        client = gemini_sdk_client(stream=broken_stream())
        with patch("lib_qwen3vl_prompt_tools.assistant_gemini._gemini_client", return_value=client) as factory:
            events = [json.loads(item) for item in prompt_assistant_stream(payload)]
        self.assertEqual(["usage", "delta", "error"], [event["type"] for event in events])
        self.assertEqual(1, factory.call_count)

    def test_gemini_sdk_receives_relay_endpoint_and_native_config(self):
        response = sdk_value({"candidates": [{"content": {"parts": [{"text": "ok"}]}}]})
        client = gemini_sdk_client(result=response)
        payload = remote_profile(protocol="gemini-native", endpoint="https://relay.example.com/v1beta", api_key="sk-test")
        with patch("lib_qwen3vl_prompt_tools.assistant_gemini._gemini_client", return_value=client) as factory:
            result = prompt_assistant_chat(payload)
        self.assertEqual("ok", result["text"])
        factory.assert_called_once_with("https://relay.example.com/v1beta", "sk-test", 30)
        request = client.__enter__.return_value.models.generate_content.call_args.kwargs
        self.assertEqual("test-model", request["model"])
        self.assertTrue(request["contents"])
        self.assertTrue(any(part.text for content in request["contents"] for part in content.parts))
        self.assertEqual(0.2, request["config"].temperature)
        self.assertEqual(1024, request["config"].max_output_tokens)
        self.assertTrue(request["config"].automatic_function_calling.disable)

    def test_openai_fallback_endpoints_are_tried_in_order(self):
        failed = sdk_client(error=RuntimeError("503 down"))
        success = sdk_client(sdk_value({"choices": [{"message": {"content": "ok"}}]}))
        payload = remote_profile(fallback_endpoints=["https://first.example.com/v1", "https://second.example.com/v1"])
        with patch("lib_qwen3vl_prompt_tools.assistant_openai._openai_client", side_effect=[failed, failed, success]) as factory:
            result = prompt_assistant_chat(payload)
        self.assertEqual("ok", result["text"])
        self.assertEqual(
            [
                "https://api.example.com/v1",
                "https://first.example.com/v1",
                "https://second.example.com/v1",
            ],
            [call.args[0] for call in factory.call_args_list],
        )

    def test_capabilities_disable_reasoning_and_streaming(self):
        client = sdk_client(sdk_value({"choices": [{"message": {"content": "ok"}}]}))
        payload = remote_profile(
            endpoint="https://api.deepseek.com",
            capabilities={"tools": True, "vision": False, "streaming": False, "reasoning": False},
        )
        with patch("lib_qwen3vl_prompt_tools.assistant_openai._openai_client", return_value=client):
            events = [json.loads(item) for item in prompt_assistant_stream(payload)]
        body = client.__enter__.return_value.chat.completions.create.call_args.kwargs
        self.assertNotIn("extra_body", body)
        self.assertNotIn("reasoning_effort", body)
        self.assertEqual(["done"], [event["type"] for event in events])

    def test_llama_endpoint_and_once_use_distinct_runtimes(self):
        endpoint_payload = remote_profile(
            runtime="llama-endpoint",
            endpoint="http://127.0.0.1:8080/v1",
            model="local-alias",
            api_key="",
        )
        once_payload = remote_profile(
            runtime="llama-once",
            endpoint="",
            model="local-alias",
            api_key="",
            model_path=r"E:\models\local.gguf",
            llama_server_path=r"E:\llama\llama-server.exe",
            parameters={"n_ctx": 4096, "thinking": True},
        )
        with patch(
            "lib_qwen3vl_prompt_tools.assistant._prompt_assistant_chat_openai",
            return_value={"text": "endpoint", "tool_calls": []},
        ) as endpoint_chat, patch(
            "lib_qwen3vl_prompt_tools.assistant._prompt_assistant_chat_local_once",
            return_value={"text": "once", "tool_calls": []},
        ) as once_chat:
            self.assertEqual("endpoint", prompt_assistant_chat(endpoint_payload)["text"])
            self.assertEqual("once", prompt_assistant_chat(once_payload)["text"])
        endpoint_chat.assert_called_once()
        once_chat.assert_called_once()
        self.assertEqual(r"E:\models\local.gguf", once_chat.call_args.args[0]["model_path"])
        self.assertEqual("local-alias", once_chat.call_args.args[0]["model"])

    def test_tool_parsing_for_both_protocols(self):
        openai = _openai_result(
            {
                "choices": [
                    {
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {
                                    "function": {
                                        "name": "read_prompt",
                                        "arguments": '{"target":"active"}',
                                    }
                                }
                            ],
                        }
                    }
                ]
            },
            {"messages": []},
            "test-model",
            "https://api.example.com/v1",
        )
        _text, gemini = _gemini_response_parts(
            {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {"functionCall": {"name": "read_prompt", "args": {"target": "active"}}}
                            ]
                        }
                    }
                ]
            }
        )
        expected = [{"tool": "read_prompt", "arguments": {"target": "active"}}]
        self.assertEqual(expected, openai["tool_calls"])
        self.assertEqual(expected, gemini)

    def test_openai_stream_parses_text_usage_and_chunked_tool_calls(self):
        chunks = [
            sdk_value({"choices": [{"delta": {"reasoning_content": "Think "}}]}),
            sdk_value({"choices": [{"delta": {"content": "Hel"}}]}),
            sdk_value({"choices": [{"delta": {"content": "lo"}}]}),
            sdk_value({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-1", "function": {"name": "read_", "arguments": '{"target":'}}]}}]}),
            sdk_value({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "prompt", "arguments": '"active"}'}}]}}]}),
            sdk_value({"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}}),
        ]
        client = sdk_client(chunks)
        with patch("lib_qwen3vl_prompt_tools.assistant_openai._openai_client", return_value=client):
            events = [json.loads(item) for item in prompt_assistant_stream(remote_profile())]
        self.assertEqual(["usage", "reasoning_delta", "delta", "delta", "usage", "done"], [item["type"] for item in events])
        self.assertEqual("Think ", events[-1]["reasoning"])
        self.assertEqual("Hello", events[-1]["text"])
        self.assertEqual([{"tool": "read_prompt", "arguments": {"target": "active"}, "id": "call-1"}], events[-1]["tool_calls"])
        self.assertEqual(13, events[-1]["usage"]["total_tokens"])
        body = client.__enter__.return_value.chat.completions.create.call_args.kwargs
        self.assertTrue(body["stream"])
        self.assertEqual({"include_usage": True}, body["stream_options"])

    def test_openai_usage_exposes_cached_prompt_tokens(self):
        result = _openai_result(
            {
                "choices": [{"message": {"content": "ok"}}],
                "usage": {
                    "prompt_tokens": 120,
                    "completion_tokens": 5,
                    "total_tokens": 125,
                    "prompt_tokens_details": {"cached_tokens": 80},
                },
            },
            {"messages": []},
            "grok-test",
            "https://example.com/v1",
        )
        self.assertEqual(80, result["usage"]["cached_tokens"])

    def test_openai_stream_fallback_endpoints_are_tried_in_order(self):
        failed = sdk_client(error=RuntimeError("503 down"))
        success = sdk_client([sdk_value({"choices": [{"delta": {"content": "ok"}}]})])
        payload = remote_profile(fallback_endpoints=["https://fallback.example.com/v1"])
        with patch("lib_qwen3vl_prompt_tools.assistant_openai._openai_client", side_effect=[failed, success]) as factory:
            events = [json.loads(item) for item in prompt_assistant_stream(payload)]
        self.assertEqual("ok", events[-1]["text"])
        self.assertEqual(
            ["https://api.example.com/v1", "https://fallback.example.com/v1"],
            [call.args[0] for call in factory.call_args_list],
        )

    def test_openai_stream_retries_without_unsupported_usage_option(self):
        rejected = sdk_client(error=RuntimeError("400 unknown parameter stream_options"))
        accepted = sdk_client([sdk_value({"choices": [{"delta": {"content": "ok"}}]})])
        with patch("lib_qwen3vl_prompt_tools.assistant_openai._openai_client", side_effect=[rejected, accepted]):
            events = [json.loads(item) for item in prompt_assistant_stream(remote_profile())]
        self.assertEqual("ok", events[-1]["text"])
        rejected_body = rejected.__enter__.return_value.chat.completions.create.call_args.kwargs
        accepted_body = accepted.__enter__.return_value.chat.completions.create.call_args.kwargs
        self.assertIn("stream_options", rejected_body)
        self.assertNotIn("stream_options", accepted_body)

    def test_ask_teacher_dispatches_explicit_profile_without_tools(self):
        teacher_profile = remote_profile(
            profile_id="teacher-openai",
            endpoint="https://teacher.example.com/v1",
            model_id="teacher-model",
            model="teacher-model",
            messages=[],
        )
        with patch(
            "lib_qwen3vl_prompt_tools.assistant._prompt_assistant_chat_openai",
            return_value={"text": "teacher advice", "model": "teacher-model", "endpoint": "https://teacher.example.com/v1"},
        ) as chat:
            result = ask_teacher(
                {
                    "question": "How should this be composed?",
                    "context": "SAFE_SLOT_001",
                    "teacher_profile": teacher_profile,
                }
            )
        dispatched = chat.call_args.args[0]
        self.assertTrue(dispatched["disable_tools"])
        self.assertEqual("teacher-openai", dispatched["profile_id"])
        self.assertIn("SAFE_SLOT_001", dispatched["messages"][0]["content"])
        self.assertEqual("teacher advice", result["text"])


if __name__ == "__main__":
    unittest.main()
