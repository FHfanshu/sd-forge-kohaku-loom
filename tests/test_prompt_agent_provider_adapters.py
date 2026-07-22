from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

import httpx

from backend.prompt_agent.contracts import parse_stream_request
from backend.prompt_agent.provider_adapters.registry import capability_report, provider_id_for
from backend.prompt_agent.providers import stream_profile
from quality.acceptance import acceptance


REAL_ASYNC_CLIENT = httpx.AsyncClient


class TrackingByteStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes], *, started: asyncio.Event | None = None, release: asyncio.Event | None = None):
        self.chunks = chunks
        self.started = started
        self.release = release
        self.closed = False

    async def __aiter__(self):
        if self.started is not None:
            self.started.set()
        if self.release is not None:
            await self.release.wait()
        for chunk in self.chunks:
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


class UpstreamHarness:
    def __init__(
        self,
        status_code: int,
        chunks: list[bytes],
        *,
        started: asyncio.Event | None = None,
        release: asyncio.Event | None = None,
    ):
        self.status_code = status_code
        self.chunks = chunks
        self.started = started
        self.release = release
        self.requests: list[httpx.Request] = []
        self.streams: list[TrackingByteStream] = []
        self.client: httpx.AsyncClient | None = None
        self.transport = httpx.MockTransport(self._handle)

    async def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        stream = TrackingByteStream(self.chunks, started=self.started, release=self.release)
        self.streams.append(stream)
        return httpx.Response(
            self.status_code,
            headers={"content-type": "text/event-stream"},
            stream=stream,
            request=request,
        )

    def client_factory(self, **kwargs) -> httpx.AsyncClient:
        self.client = REAL_ASYNC_CLIENT(
            transport=self.transport,
            timeout=kwargs.get("timeout"),
            trust_env=kwargs.get("trust_env", True),
        )
        return self.client


def frame(data: dict | str, event_name: str | None = None) -> bytes:
    value = data if isinstance(data, str) else json.dumps(data)
    prefix = f"event: {event_name}\n" if event_name else ""
    return f"{prefix}data: {value}\n\n".encode()


def openai_frames(*, tool: bool = False) -> list[bytes]:
    if tool:
        return [
            frame({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-1", "function": {"name": "lookup", "arguments": '{"q":"x"}'}}]}}]}),
            frame({"choices": [], "usage": {"prompt_tokens": 4, "completion_tokens": 2}}),
            frame("[DONE]"),
        ]
    return [
        frame({"choices": [{"delta": {"reasoning_content": "think"}}]}),
        frame({"choices": [{"delta": {"content": "hello"}}]}),
        frame({"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 2}}),
        frame("[DONE]"),
    ]


def gemini_frames(*, tool: bool = False) -> list[bytes]:
    part = {"functionCall": {"name": "lookup", "args": {"q": "x"}}} if tool else None
    parts = [part] if part else [{"text": "think", "thought": True}, {"text": "hello"}]
    return [frame({
        "candidates": [{
            "content": {"parts": parts},
            "finishReason": "STOP",
        }],
        "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 2},
    })]


def request(*, tools: bool = False, request_id: str = "adapter-request", tool_choice: str = ""):
    return parse_stream_request({
        "profile_id": "profile",
        "request_id": request_id,
        "context": {
            "systemPrompt": "system",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hello"}, {"type": "image", "mimeType": "image/png", "data": "aW1hZ2U="}]}],
            "tools": [{"name": "lookup", "description": "Find", "parameters": {"type": "object"}}] if tools else [],
        },
        "options": {"reasoning": "medium", "maxTokens": 128, "toolChoice": tool_choice or None},
    })


def profile(provider: str) -> dict:
    common = {
        "profile_id": "profile",
        "display_name": provider,
        "model_id": "model",
        "enabled": True,
        "runtime": "remote-http",
        "capabilities": {"tools": True, "vision": True, "streaming": True, "reasoning": True},
        "parameters": {"temperature": 0.25, "top_p": 0.9, "max_tokens": 128, "timeout": 5},
        "api_key": "provider-secret",
    }
    if provider == "gemini":
        return {**common, "protocol": "gemini-native", "endpoint": "https://generativelanguage.googleapis.com"}
    if provider == "llama-cpp":
        return {
            **common,
            "protocol": "openai-chat-completions",
            "runtime": "llama-once",
            "endpoint": "http://127.0.0.1:8080/v1",
            "model_path": "C:/models/local.gguf",
            "api_key": "",
        }
    return {**common, "protocol": "openai-chat-completions", "endpoint": "https://provider.invalid/v1"}


def events_from_frames(frames: list[str]) -> list[dict]:
    return [json.loads(value[5:].strip()) for value in frames]


class ProviderAdapterContractTests(unittest.TestCase):
    def collect(self, harness: UpstreamHarness, provider: str, *, tools: bool = False) -> list[dict]:
        async def run() -> list[dict]:
            with patch("backend.prompt_agent.providers.httpx.AsyncClient", new=harness.client_factory):
                return events_from_frames([frame async for frame in stream_profile(request(tools=tools), profile(provider))])

        return asyncio.run(run())

    def collect_forced_tool(self, harness: UpstreamHarness, provider: str) -> dict:
        async def run() -> dict:
            with patch("backend.prompt_agent.providers.httpx.AsyncClient", new=harness.client_factory):
                async for _frame in stream_profile(request(tools=True, tool_choice="lookup"), profile(provider)):
                    pass
            return json.loads(harness.requests[0].content)

        return asyncio.run(run())

    def test_registry_resolves_all_provider_ids_and_reports_explicit_capabilities(self):
        profiles = {
            "openai-compatible": profile("openai-compatible"),
            "gemini": profile("gemini"),
            "llama-cpp": profile("llama-cpp"),
        }
        self.assertEqual(set(profiles), {provider_id_for(item) for item in profiles.values()})
        explicit = profile("openai-compatible") | {"provider_id": "openrouter", "endpoint": "https://gateway.invalid/v1"}
        self.assertEqual("openai-compatible", provider_id_for(explicit))
        self.assertEqual("unsupported-provider", provider_id_for(profile("openai-compatible") | {"provider_id": "unsupported-provider"}))
        limited = {**profiles["openai-compatible"], "capabilities": {"tools": False}}
        report = capability_report(limited)
        self.assertFalse(report["effective"]["tools"])
        self.assertIn("tools", report["unsupported"])
        once_report = capability_report(profile("llama-cpp") | {"runtime": "llama-once"})
        self.assertTrue(once_report["supported"]["streaming"])
        self.assertNotIn("abort", once_report["unsupported"])

    def test_each_adapter_normalizes_text_reasoning_and_usage(self):
        cases = {
            "openai-compatible": openai_frames(),
            "gemini": gemini_frames(),
            "llama-cpp": openai_frames(),
        }
        for provider, chunks in cases.items():
            with self.subTest(provider=provider):
                harness = UpstreamHarness(200, chunks)
                events = self.collect(harness, provider)
                types = [event["type"] for event in events]
                self.assertIn("text_delta", types)
                self.assertIn("done", types)
                self.assertEqual(5, events[-1]["usage"]["input"])
                self.assertEqual(2, events[-1]["usage"]["output"])
                self.assertIn("thinking_delta", types)

    @acceptance("PROVIDER-TOOLS-001@2", "normalization")
    def test_each_adapter_normalizes_tool_calls_and_native_request_schema(self):
        cases = {
            "openai-compatible": openai_frames(tool=True),
            "gemini": gemini_frames(tool=True),
            "llama-cpp": openai_frames(tool=True),
        }
        for provider, chunks in cases.items():
            with self.subTest(provider=provider):
                harness = UpstreamHarness(200, chunks)
                events = self.collect(harness, provider, tools=True)
                self.assertEqual("toolUse", events[-1]["reason"])
                start = next(item for item in events if item["type"] == "toolcall_start")
                self.assertEqual("lookup", start["toolName"])
                body = json.loads(harness.requests[0].content)
                if provider in {"openai-compatible", "llama-cpp"}:
                    self.assertEqual("lookup", body["tools"][0]["function"]["name"])
                else:
                    self.assertEqual("lookup", body["tools"][0]["functionDeclarations"][0]["name"])
                if provider in {"openai-compatible", "llama-cpp"}:
                    self.assertEqual("image_url", body["messages"][1]["content"][1]["type"])
                else:
                    self.assertIn("inlineData", body["contents"][0]["parts"][1])
                    self.assertEqual("provider-secret", harness.requests[0].headers["x-goog-api-key"])
                    self.assertNotIn("key=", str(harness.requests[0].url))

    @acceptance("PROVIDER-TOOLS-001@2", "forced-choice")
    def test_each_adapter_forces_the_requested_declared_tool(self):
        cases = {
            "openai-compatible": openai_frames(tool=True),
            "gemini": gemini_frames(tool=True),
            "llama-cpp": openai_frames(tool=True),
        }
        for provider, chunks in cases.items():
            with self.subTest(provider=provider):
                body = self.collect_forced_tool(UpstreamHarness(200, chunks), provider)
                if provider in {"openai-compatible", "llama-cpp"}:
                    self.assertEqual({"type": "function", "function": {"name": "lookup"}}, body["tool_choice"])
                else:
                    self.assertEqual({"mode": "ANY", "allowedFunctionNames": ["lookup"]}, body["toolConfig"]["functionCallingConfig"])

    def test_rejects_forced_tool_that_was_not_declared(self):
        with self.assertRaisesRegex(ValueError, "declared tool"):
            request(tools=True, tool_choice="missing")

    def test_each_adapter_sanitizes_terminal_http_errors(self):
        for provider in ("openai-compatible", "gemini", "llama-cpp"):
            with self.subTest(provider=provider):
                harness = UpstreamHarness(401, [frame('{"error":{"message":"provider-secret"}}')])
                events = self.collect(harness, provider)
                self.assertEqual(["start", "error"], [event["type"] for event in events])
                self.assertNotIn("provider-secret", json.dumps(events))
                self.assertIn("credentials", events[-1]["errorMessage"])

    @acceptance("PROVIDER-TOOLS-001@2", "abort")
    def test_each_adapter_cancellation_closes_upstream_work(self):
        async def run(provider: str) -> tuple[list[str], TrackingByteStream, httpx.AsyncClient]:
            started = asyncio.Event()
            release = asyncio.Event()
            harness = UpstreamHarness(200, [], started=started, release=release)
            generator = stream_profile(request(request_id=f"cancel-{provider}"), profile(provider))
            received = [json.loads((await anext(generator))[5:].strip())["type"]]

            async def consume() -> None:
                async for item in generator:
                    received.append(json.loads(item[5:].strip())["type"])

            with patch("backend.prompt_agent.providers.httpx.AsyncClient", new=harness.client_factory):
                task = asyncio.create_task(consume())
                await asyncio.wait_for(started.wait(), timeout=1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertIsNotNone(harness.client)
            return received, harness.streams[0], harness.client

        for provider in ("openai-compatible", "gemini", "llama-cpp"):
            with self.subTest(provider=provider):
                received, stream, client = asyncio.run(run(provider))
                self.assertEqual(["start"], received)
                self.assertTrue(stream.closed)
                self.assertTrue(client.is_closed)

if __name__ == "__main__":
    unittest.main()
