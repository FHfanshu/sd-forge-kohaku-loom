from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


try:
    from kohakuterrarium.core.agent import Agent
    from kohakuterrarium.llm.base import NativeToolCall
    from kohakuterrarium.llm.base import ToolSchema
    from kohakuterrarium.testing.llm import ScriptEntry, ScriptedLLM

    from kohaku_loom.forge_bridge import ForgeToolBroker
    from kohaku_loom.forge_tools import ReadPromptTool, forge_tools, yolo_forge_tools
    from kohaku_loom.profile_store import LoomProfileStore
    from kohaku_loom.runtime_paths import LoomRuntimePaths
    from kohaku_loom.sidecar.runtime import LoomSidecarRuntime
    from kohaku_loom.kt_providers import GeminiNativeProvider, LlamaOnceProvider, ProfileOpenAIProvider, _retryable_provider_error
    from kohaku_loom.provider_errors import provider_http_status

    KT_AVAILABLE = True
except (ImportError, ModuleNotFoundError):
    KT_AVAILABLE = False


if KT_AVAILABLE:
    class NativeScriptedLLM(ScriptedLLM):
        def __init__(self):
            super().__init__([ScriptEntry("I will inspect the prompt."), ScriptEntry("The prompt contains a subject.")])
            self.last_tool_calls: list[NativeToolCall] = []
            self.last_assistant_extra_fields = {}
            self.last_usage = {}

        async def chat(self, messages, **kwargs):
            index = self.call_count
            self.last_tool_calls = []
            async for chunk in super().chat(messages, **kwargs):
                yield chunk
            if index == 0:
                self.last_tool_calls = [
                    NativeToolCall(
                        id="read-1",
                        name="read_prompt",
                        arguments='{"target":"active"}',
                    )
                ]


@unittest.skipUnless(KT_AVAILABLE, "KohakuTerrarium sidecar dependency is not installed")
class KohakuTerrariumContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_forge_bridge_exposes_legacy_browser_capabilities(self):
        tools = forge_tools(ForgeToolBroker())
        names = {tool.tool_name for tool in tools}
        self.assertEqual(
            {
                "ask_teacher",
                "read_prompt",
                "read_style_template",
                "edit_prompt",
                "initialize_prompt",
                "forge_resource",
                "danbooru",
                "load_prompt_skill",
            },
            names,
        )
        edit = next(tool for tool in tools if tool.tool_name == "edit_prompt")
        self.assertIn("prompt", edit.parameters["properties"])
        self.assertNotIn("diff", edit.parameters["required"])

    async def test_direct_tools_expose_danbooru_actions_and_prompt_skill_name(self):
        tools = {tool.tool_name: tool for tool in forge_tools(ForgeToolBroker())}
        self.assertEqual(
            {"search", "inspect", "inspect_batch", "related"},
            set(tools["danbooru"].parameters["properties"]["action"]["enum"]),
        )
        self.assertEqual(["name"], tools["load_prompt_skill"].parameters["required"])

    async def test_yolo_tools_are_separate_and_fail_closed_in_normal_mode(self):
        broker = ForgeToolBroker()
        mode = "normal"
        tools = yolo_forge_tools(broker, mode_provider=lambda: mode)
        self.assertEqual(
            {"read_txt2img_state", "apply_txt2img_patch"},
            {tool.tool_name for tool in tools},
        )

        result = await tools[0]._execute({})

        self.assertEqual("yolo_mode_required", result.error)
        self.assertEqual([], [event for event in broker.events_after(0) if event["type"] == "tool_request"])

    async def test_forge_tool_unwraps_structured_content_arguments(self):
        broker = ForgeToolBroker()
        tool = next(tool for tool in forge_tools(broker) if tool.tool_name == "edit_prompt")
        arguments = {
            "content": json.dumps(
                {
                    "field": "positive",
                    "base_hash": "fnv1a:prompt",
                    "prompt": "subject, warm lighting",
                }
            )
        }
        task = asyncio.create_task(tool._execute(arguments))
        request = await self._wait_for_request(broker)
        self.assertEqual(
            {
                "field": "positive",
                "base_hash": "fnv1a:prompt",
                "prompt": "subject, warm lighting",
            },
            request["payload"]["arguments"],
        )
        await broker.reply(request["payload"]["request_id"], {"ok": True, "changed": True})
        self.assertIsNone((await task).error)

    async def test_danbooru_compatibility_recovers_content_query(self):
        tool = next(tool for tool in forge_tools(ForgeToolBroker()) if tool.tool_name == "danbooru")
        with mock.patch(
            "kohaku_loom.kt_tools.search_danbooru_tags",
            return_value={"ok": True, "items": []},
        ) as search:
            result = await tool._execute({"content": "search from below"})
        self.assertIsNone(result.error)
        search.assert_called_once_with("from below", "", 12, None)

    async def test_yolo_request_keeps_issued_authorization_after_mode_switch(self):
        broker = ForgeToolBroker()
        mode = "yolo"
        tool = next(tool for tool in forge_tools(broker, mode_provider=lambda: mode) if tool.tool_name == "edit_prompt")
        task = asyncio.create_task(tool._execute({"base_hash": "fnv1a:prompt"}))
        request = await self._wait_for_request(broker)
        mode = "normal"

        self.assertEqual("yolo", request["payload"]["agent_mode"])
        self.assertNotIn("_yolo_authorized", request["payload"]["arguments"])
        await broker.reply(request["payload"]["request_id"], {"ok": True, "state_hash": "fnv1a:state"})
        result = await task

        self.assertIsNone(result.error)
        forged_task = asyncio.create_task(tool._execute({"base_hash": "fnv1a:prompt", "_yolo_authorized": True}))
        forged_request = await self._wait_for_request(broker, 2)
        self.assertEqual("normal", forged_request["payload"]["agent_mode"])
        self.assertNotIn("_yolo_authorized", forged_request["payload"]["arguments"])
        await broker.reply(forged_request["payload"]["request_id"], {"ok": True})
        self.assertIsNone((await forged_task).error)

    async def test_installed_loom_creature_loads_package_tool_and_skill(self):
        from kohakuterrarium import Terrarium
        from kohakuterrarium.terrarium.drive.config import DriveRuntimeConfig

        extension_root = Path(__file__).resolve().parents[1]
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.dict(
                os.environ,
                {
                    "KT_CONFIG_DIR": str(extension_root / ".loom" / "config"),
                    "KT_SESSION_DIR": str(extension_root / ".loom" / "sessions"),
                },
            ),
        ):
            engine = Terrarium(
                pwd=directory,
                session_dir=directory,
                drive_config=DriveRuntimeConfig(enabled=False),
            )
            try:
                creature = await engine.add_creature(
                    "@kohaku-loom/creatures/loom",
                    creature_id="loom-package-contract",
                    llm=ScriptedLLM([ScriptEntry("ok")]),
                    io="headless",
                    strict=True,
                    start=False,
                )
                self.assertIn("danbooru", creature.agent.registry.list_tools())
                self.assertIn("danbooru-prompting", creature.agent.skills.names())
                skill = creature.agent.skills.get("danbooru-prompting")
                self.assertTrue(skill.enabled)
                self.assertIn("Danbooru", skill.body)
            finally:
                await engine.shutdown()

    async def test_agent_waits_for_browser_tool_and_continues(self):
        broker = ForgeToolBroker()
        llm = NativeScriptedLLM()
        with tempfile.TemporaryDirectory() as directory:
            creature = Path(directory)
            (creature / "config.yaml").write_text(
                """name: loom_contract
version: \"1.0\"
controller:
  tool_format: native
system_prompt: \"Use the available Forge tools when needed.\"
input:
  type: none
output:
  type: stdout
""",
                encoding="utf-8",
            )
            agent = await Agent.build(
                creature,
                llm=llm,
                io="headless",
                tools=[ReadPromptTool(broker, timeout=10)],
            )
            await agent.start()
            try:
                turn = asyncio.create_task(agent.run("Read the current prompt."))
                request = await self._wait_for_request(broker)
                self.assertEqual("read_prompt", request["payload"]["tool"])
                self.assertEqual({"target": "active"}, request["payload"]["arguments"])
                status = await broker.reply(
                    request["payload"]["request_id"],
                    {"ok": True, "positive_prompt": "subject", "prompt_hash": "fnv1a:1"},
                )
                self.assertEqual("accepted", status)
                result = await asyncio.wait_for(turn, timeout=15)
            finally:
                await agent.stop()

        self.assertEqual("ok", result.status)
        self.assertIn("subject", result.text)
        self.assertEqual(2, llm.call_count)
        self.assertIn("positive_prompt", json.dumps(llm.call_log[1], ensure_ascii=False))

    async def test_late_reply_is_rejected(self):
        broker = ForgeToolBroker()
        task = asyncio.create_task(broker.request("read_prompt", {}, timeout=10))
        request = await self._wait_for_request(broker)
        request_id = request["payload"]["request_id"]
        self.assertEqual("accepted", await broker.reply(request_id, {"ok": True}))
        await task
        self.assertEqual("unknown", await broker.reply(request_id, {"ok": True}))

    async def test_only_claimed_forge_tab_can_reply_to_tool_request(self):
        broker = ForgeToolBroker()
        claim = await broker.claim_bridge("tab-a")
        self.assertTrue(claim["owned"])
        self.assertFalse((await broker.claim_bridge("tab-b"))["owned"])
        task = asyncio.create_task(broker.request("read_prompt", {}, timeout=10))
        request = await self._wait_for_request(broker)
        request_id = request["payload"]["request_id"]

        self.assertEqual("foreign", await broker.reply(request_id, {"ok": True}, "tab-b"))
        self.assertEqual("accepted", await broker.reply(request_id, {"ok": True}, "tab-a"))
        await task

    async def test_duplicate_pending_mutation_fingerprint_reuses_browser_request(self):
        broker = ForgeToolBroker()
        broker.begin_session("session")
        arguments = {
            "target": "txt2img",
            "field": "positive",
            "base_hash": "fnv1a:old",
            "prompt": "subject",
        }
        first = asyncio.create_task(broker.request("edit_prompt", arguments, timeout=10))
        request = await self._wait_for_request(broker)
        replay = asyncio.create_task(broker.request("edit_prompt", arguments, timeout=10))
        await asyncio.sleep(0)
        await broker.reply(request["payload"]["request_id"], {"ok": True, "changed": True})
        self.assertTrue((await first)["changed"])
        self.assertTrue((await replay)["changed"])
        requests = [event for event in broker.events_after(0) if event["type"] == "tool_request"]
        self.assertEqual(1, len(requests))

    async def test_duplicate_pending_txt2img_patch_reuses_browser_request(self):
        broker = ForgeToolBroker()
        broker.begin_session("session")
        arguments = {"state_hash": "fnv1a:state", "changes": {"steps": 28}}
        first = asyncio.create_task(broker.request("apply_txt2img_patch", arguments, timeout=10))
        request = await self._wait_for_request(broker)
        replay = asyncio.create_task(broker.request("apply_txt2img_patch", arguments, timeout=10))
        await asyncio.sleep(0)
        await broker.reply(request["payload"]["request_id"], {"ok": True, "changed": True})

        self.assertTrue((await first)["changed"])
        self.assertTrue((await replay)["changed"])
        requests = [event for event in broker.events_after(0) if event["type"] == "tool_request"]
        self.assertEqual(1, len(requests))

    async def test_completed_mutation_is_revalidated_by_browser(self):
        broker = ForgeToolBroker()
        broker.begin_session("session")
        arguments = {
            "target": "txt2img",
            "field": "positive",
            "base_hash": "fnv1a:old",
            "prompt": "subject",
        }
        first = asyncio.create_task(broker.request("edit_prompt", arguments, timeout=10))
        request = await self._wait_for_request(broker)
        await broker.reply(request["payload"]["request_id"], {"ok": True, "changed": True})
        await first

        replay = asyncio.create_task(broker.request("edit_prompt", arguments, timeout=10))
        second_request = await self._wait_for_request(broker, expected_count=2)
        await broker.reply(second_request["payload"]["request_id"], {"ok": False, "error": "stale context"})

        self.assertFalse((await replay)["ok"])
        requests = [event for event in broker.events_after(0) if event["type"] == "tool_request"]
        self.assertEqual(2, len(requests))

    async def test_sidecar_runtime_persists_and_resumes_one_creature_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            creature = root / "creature"
            creature.mkdir()
            (creature / "config.yaml").write_text(
                """name: loom_runtime_contract
version: "1.0"
controller:
  tool_format: native
system_prompt: "Answer concisely."
input:
  type: none
output:
  type: stdout
""",
                encoding="utf-8",
            )
            paths = LoomRuntimePaths.under(root).ensure()
            broker = ForgeToolBroker()
            first_llm = ScriptedLLM([ScriptEntry("First answer.")])
            runtime = LoomSidecarRuntime(
                paths,
                LoomProfileStore(paths),
                broker,
                creature_ref=creature,
            )
            opened = await runtime.open_session(
                "test-profile",
                session_id="contract",
                forge_bridge=False,
                provider=first_llm,
            )
            self.assertFalse(opened["resumed"])
            first_turn = await runtime.start_turn("First question")
            await asyncio.wait_for(runtime._turn_task, timeout=10)
            first_history = runtime.session_conversation("contract")
            await runtime.close_session()
            self.assertTrue((paths.sessions / "contract.kohakutr").is_file())

            second_llm = ScriptedLLM([ScriptEntry("Second answer.")])
            resumed = await runtime.open_session(
                "test-profile",
                session_id="contract",
                resume=True,
                forge_bridge=False,
                provider=second_llm,
            )
            self.assertTrue(resumed["resumed"])
            second_turn = await runtime.start_turn("Second question")
            await asyncio.wait_for(runtime._turn_task, timeout=10)
            await runtime.close()

        self.assertNotEqual(first_turn["turn_id"], second_turn["turn_id"])
        self.assertTrue(any(message.get("content") == "First question" for message in first_history["messages"]))
        self.assertTrue(any(message.get("content") == "First answer." for message in first_history["messages"]))
        resumed_context = json.dumps(second_llm.call_log[0], ensure_ascii=False)
        self.assertIn("First question", resumed_context)
        self.assertIn("First answer", resumed_context)
        ended = [event for event in runtime.events.after(0) if event["type"] == "turn_ended"]
        self.assertEqual(["ok", "ok"], [event["payload"]["status"] for event in ended])

    async def test_openai_profile_falls_back_before_streaming_content(self):
        class FakeProvider:
            def __init__(self, response=None, error=None):
                self.response = response
                self.error = error
                self.last_tool_calls = []
                self.last_usage = {"total_tokens": 3}
                self.last_assistant_extra_fields = {}

            async def chat(self, messages, **kwargs):
                del messages, kwargs
                if self.error:
                    raise self.error
                yield self.response

            async def close(self):
                return None

        failed = FakeProvider(error=RuntimeError("primary unavailable"))
        fallback = FakeProvider(response="fallback response")
        profile = {
            "model": "test-model",
            "endpoint": "https://primary.example/v1",
            "fallback_endpoints": ["https://fallback.example/v1"],
            "api_key": "secret",
        }
        with mock.patch.object(ProfileOpenAIProvider, "_provider", side_effect=[failed, fallback]):
            provider = ProfileOpenAIProvider(profile)
        chunks = [chunk async for chunk in provider.chat([{"role": "user", "content": "hello"}])]
        await provider.close()

        self.assertEqual(["fallback response"], chunks)
        self.assertEqual(3, provider.last_usage["total_tokens"])

    async def test_openai_profile_recovers_after_partial_content(self):
        class PartialProvider:
            last_tool_calls = []
            last_usage = {}
            last_assistant_extra_fields = {}

            async def chat(self, messages, **kwargs):
                del messages, kwargs
                yield "partial"
                raise RuntimeError("stream failed")

            async def close(self):
                return None

        class FallbackProvider(PartialProvider):
            async def chat(self, messages, **kwargs):
                del messages, kwargs
                yield "must not run"

        with mock.patch.object(
            ProfileOpenAIProvider,
            "_provider",
            side_effect=[PartialProvider(), FallbackProvider()],
        ):
            provider = ProfileOpenAIProvider(
                {
                    "model": "test-model",
                    "endpoint": "https://primary.example/v1",
                    "fallback_endpoints": ["https://fallback.example/v1"],
                    "api_key": "secret",
                }
            )
        chunks = []
        async for chunk in provider.chat([{"role": "user", "content": "hello"}]):
            chunks.append(chunk)
        await provider.close()

        self.assertEqual(["partial", "must not run"], chunks)

    async def test_openai_native_tool_round_fails_closed_on_broken_stream(self):
        class PartialProvider:
            last_tool_calls = []
            last_usage = {}
            last_assistant_extra_fields = {}

            async def chat(self, messages, **kwargs):
                del messages, kwargs
                raise RuntimeError("stream failed after hidden tool delta")
                yield ""

            async def close(self):
                return None

        with mock.patch.object(ProfileOpenAIProvider, "_provider", return_value=PartialProvider()):
            provider = ProfileOpenAIProvider({
                "model": "test-model",
                "endpoint": "https://primary.example/v1",
                "api_key": "secret",
            })

        with self.assertRaisesRegex(RuntimeError, "paused to avoid a duplicate tool call"):
            _ = [chunk async for chunk in provider.chat(
                [{"role": "user", "content": "edit prompt"}],
                tools=[ToolSchema(name="edit_prompt", description="Edit prompt", parameters={"type": "object"})],
            )]

    def test_gemini_native_request_preserves_tool_round(self):
        provider = GeminiNativeProvider(
            {
                "model": "gemini-test",
                "endpoint": "https://generativelanguage.googleapis.com",
                "api_key": "secret",
                "reasoning_effort": "none",
            }
        )
        body = provider._request_body(
            [
                {"role": "system", "content": "System guidance"},
                {"role": "user", "content": "Read the prompt"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {"name": "read_prompt", "arguments": '{"target":"active"}'},
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "call-1",
                    "name": "read_prompt",
                    "content": '{"ok":true,"positive_prompt":"subject"}',
                },
            ],
            [ToolSchema(name="read_prompt", description="Read prompt", parameters={"type": "object"})],
        )

        self.assertEqual("System guidance", body["systemInstruction"]["parts"][0]["text"])
        self.assertEqual("read_prompt", body["contents"][1]["parts"][0]["functionCall"]["name"])
        self.assertEqual("read_prompt", body["contents"][2]["parts"][0]["functionResponse"]["name"])
        self.assertEqual("read_prompt", body["tools"][0]["functionDeclarations"][0]["name"])

    async def test_gemini_retry_preserves_partial_native_tool_call(self):
        class GoogleClientError(RuntimeError):
            def __init__(self, status, message):
                super().__init__(message)
                self.code = status

        for status in (401, 403):
            error = GoogleClientError(status, f"{status} invalid credential")
            self.assertEqual(status, provider_http_status(error))
            self.assertFalse(_retryable_provider_error(error))
        self.assertTrue(_retryable_provider_error(GoogleClientError(429, "rate limited")))
        self.assertTrue(_retryable_provider_error(GoogleClientError(503, "unavailable")))
        self.assertFalse(_retryable_provider_error(GoogleClientError(400, "bad request")))

        class Stream:
            def __init__(self, responses, error=None):
                self.responses = responses
                self.error = error

            def __aiter__(self):
                self.index = 0
                return self

            async def __anext__(self):
                if self.index < len(self.responses):
                    value = self.responses[self.index]
                    self.index += 1
                    return value
                if self.error:
                    error, self.error = self.error, None
                    raise error
                raise StopAsyncIteration

        class Client:
            def __init__(self, stream, captured):
                self.aio = self
                self.models = self
                self.stream = stream
                self.captured = captured

            async def generate_content_stream(self, **kwargs):
                self.captured.append(kwargs["contents"])
                return self.stream

            async def aclose(self):
                return None

        first_data = {
            "candidates": [{"content": {"parts": [{"functionCall": {"id": "call-1", "name": "read_prompt", "args": {"target": "active"}}}]}}]
        }
        captured = []
        clients = [Client(Stream([first_data], RuntimeError("stream failed")), captured)]
        provider = GeminiNativeProvider({
            "model": "gemini-test",
            "endpoint": "https://primary.example",
            "fallback_endpoints": ["https://fallback.example"],
            "api_key": "secret",
            "timeout": 30,
        })
        provider._retry_delay = mock.AsyncMock()

        with mock.patch("kohaku_loom.kt_providers._gemini_client", side_effect=clients):
            chunks = [chunk async for chunk in provider.chat(
                [{"role": "user", "content": "Read the prompt"}],
                tools=[ToolSchema(name="read_prompt", description="Read prompt", parameters={"type": "object"})],
            )]

        self.assertEqual([], chunks)
        self.assertEqual(1, len(captured))
        self.assertEqual("read_prompt", provider.last_tool_calls[0].name)

    async def test_llama_once_reuses_provider_within_turn_and_releases_afterward(self):
        class FakeProvider:
            def __init__(self):
                self.closed = 0
                self.last_tool_calls = []
                self.last_usage = {}
                self.last_assistant_extra_fields = {}

            async def chat(self, messages, **kwargs):
                del messages, kwargs
                yield "ok"

            async def close(self):
                self.closed += 1

        provider = LlamaOnceProvider(
            {"model": "local-model", "model_path": "C:\\models\\model.gguf"}
        )
        fake = FakeProvider()
        provider._provider = fake
        await provider.begin_turn()
        provider._provider = fake
        first = [chunk async for chunk in provider.chat([{"role": "user", "content": "one"}])]
        second = [chunk async for chunk in provider.chat([{"role": "user", "content": "two"}])]
        await provider.end_turn()

        self.assertEqual(["ok"], first)
        self.assertEqual(["ok"], second)
        self.assertEqual(2, fake.closed)
        self.assertIsNone(provider._provider)

    async def _wait_for_request(self, broker: ForgeToolBroker, expected_count: int = 1) -> dict:
        for _ in range(200):
            events = broker.events_after(0)
            requests = [event for event in events if event["type"] == "tool_request"]
            if len(requests) >= expected_count:
                return requests[-1]
            await asyncio.sleep(0.01)
        self.fail("tool request was not published")


if __name__ == "__main__":
    unittest.main()
