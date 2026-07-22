from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

from fastapi import FastAPI
import httpx

from backend.prompt_agent import API_PREFIX, register_prompt_agent_api
from backend.prompt_agent.contracts import parse_stream_request
from backend.prompt_agent.errors import sanitize_provider_error
from backend.prompt_agent.provider_adapters.common import openai_chat_url
from backend.prompt_agent.providers import stream_profile


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
    def __init__(self, status_code: int, chunks: list[bytes], *, started: asyncio.Event | None = None, release: asyncio.Event | None = None):
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


class StaticProfileAuthority:
    def __init__(self, profile: dict):
        self.profile = profile
        self.resolved: list[str] = []

    def resolve(self, profile_id: str) -> dict:
        self.resolved.append(profile_id)
        if profile_id != self.profile["profile_id"]:
            raise KeyError(profile_id)
        return dict(self.profile)


def sse(*payloads: dict | str) -> list[bytes]:
    chunks: list[bytes] = []
    for payload in payloads:
        value = payload if isinstance(payload, str) else json.dumps(payload)
        chunks.append(f"data: {value}\n\n".encode())
    return chunks


def events_from_body(body: str) -> list[dict]:
    return [
        json.loads(line[5:].strip())
        for frame in body.split("\n\n")
        for line in frame.splitlines()
        if line.startswith("data:")
    ]


def profile(api_key: str = "provider-secret") -> dict:
    return {
        "profile_id": "remote",
        "display_name": "Remote",
        "model_id": "proxy-model",
        "enabled": True,
        "protocol": "openai-chat-completions",
        "runtime": "remote-http",
        "endpoint": "https://upstream.invalid/v1",
        "fallback_endpoints": [],
        "capabilities": {"tools": True, "vision": True, "streaming": True, "reasoning": True},
        "parameters": {"temperature": 0.25, "top_p": 0.9, "max_tokens": 128, "timeout": 5},
        "api_key": api_key,
    }


def request(request_id: str = "request-123", *, tools: list[dict] | None = None) -> object:
    return parse_stream_request({
        "profile_id": "remote",
        "request_id": request_id,
        "context": {
            "systemPrompt": "System instruction",
            "messages": [{"role": "user", "content": "body-secret"}],
            "tools": tools or [],
        },
        "options": {"temperature": 0.4, "topP": 0.8, "maxTokens": 64, "reasoning": "medium"},
    })


class ProviderProxyTests(unittest.TestCase):
    def collect(self, harness: UpstreamHarness, stream_request: object, stream_profile_data: dict) -> list[dict]:
        async def run() -> list[dict]:
            with patch("backend.prompt_agent.providers.httpx.AsyncClient", new=harness.client_factory):
                return [json.loads(frame[5:].strip()) async for frame in stream_profile(stream_request, stream_profile_data)]

        return asyncio.run(run())

    def test_transport_end_of_stream_is_classified_for_safe_pre_output_retry(self):
        class EndOfStream(Exception):
            pass

        wrapped = httpx.ReadError("provider disconnected")
        wrapped.__cause__ = EndOfStream()

        error = sanitize_provider_error(wrapped)

        self.assertEqual("provider_unexpected_eof", error.code)
        self.assertEqual("The provider stream ended before completion.", error.message)

    def test_openai_compatibility_base_path_is_preserved_for_streaming(self):
        self.assertEqual(
            "https://hk-api.moyuu.cc/v1beta/openai/chat/completions",
            openai_chat_url("https://hk-api.moyuu.cc/v1beta/openai"),
        )

    def test_openai_text_reasoning_usage_and_request_id_contract(self):
        harness = UpstreamHarness(200, sse(
            {"choices": [{"delta": {"reasoning_content": "Think first."}}]},
            {"choices": [{"delta": {"content": "Hello"}}]},
            {"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 3, "prompt_tokens_details": {"cached_tokens": 2}}},
            "[DONE]",
        ))
        authority = StaticProfileAuthority(profile())
        app = FastAPI()
        register_prompt_agent_api(app, authority)
        payload = {
            "profile_id": "remote",
            "request_id": "request-123",
            "context": {"systemPrompt": "System instruction", "messages": [{"role": "user", "content": "body-secret"}]},
            "options": {"temperature": 0.4, "topP": 0.8, "maxTokens": 64, "reasoning": "medium"},
        }

        async def call_route() -> httpx.Response:
            client = REAL_ASYNC_CLIENT(transport=httpx.ASGITransport(app=app), base_url="http://testserver")
            try:
                with patch("backend.prompt_agent.providers.httpx.AsyncClient", new=harness.client_factory):
                    return await client.post(f"{API_PREFIX}/stream", json=payload)
            finally:
                await client.aclose()

        with self.assertLogs("prompt_agent.provider_proxy", level="INFO") as captured:
            response = asyncio.run(call_route())

        self.assertEqual(200, response.status_code)
        self.assertEqual("request-123", response.headers["x-request-id"])
        self.assertEqual(["remote"], authority.resolved)
        self.assertEqual("https://upstream.invalid/v1/chat/completions", str(harness.requests[0].url))
        self.assertEqual("Bearer provider-secret", harness.requests[0].headers["authorization"])
        sent_body = json.loads(harness.requests[0].content)
        self.assertEqual("proxy-model", sent_body["model"])
        self.assertEqual("System instruction", sent_body["messages"][0]["content"])
        self.assertEqual("body-secret", sent_body["messages"][1]["content"])
        self.assertNotIn("provider-secret", harness.requests[0].content.decode())
        self.assertTrue(sent_body["stream"])
        self.assertEqual({"include_usage": True}, sent_body["stream_options"])

        events = events_from_body(response.text)
        self.assertEqual(
            ["start", "thinking_start", "thinking_delta", "text_start", "text_delta", "thinking_end", "text_end", "done"],
            [event["type"] for event in events],
        )
        self.assertEqual("Think first.", events[2]["delta"])
        self.assertEqual("Hello", events[4]["delta"])
        self.assertEqual(7, events[-1]["usage"]["input"])
        self.assertEqual(3, events[-1]["usage"]["output"])
        self.assertEqual(2, events[-1]["usage"]["cacheRead"])
        self.assertIn("request_id=request-123", captured.output[0])
        self.assertIn("provider_id=openai-compatible", captured.output[0])
        self.assertIn("status=200", captured.output[0])
        self.assertIn("error_code=none", captured.output[0])
        for forbidden in ("provider-secret", "body-secret", "Authorization", "Content-Type"):
            self.assertNotIn(forbidden, captured.output[0])
        self.assertTrue(harness.streams[0].closed)
        self.assertTrue(harness.client is not None and harness.client.is_closed)

    def test_openai_tool_call_fragments_preserve_event_contract(self):
        harness = UpstreamHarness(200, sse(
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-1", "function": {"name": "lookup", "arguments": '{"q":'}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '"value"}'}}]}}]},
            {"choices": [], "usage": {"input_tokens": 4, "output_tokens": 2}},
            "[DONE]",
        ))

        events = self.collect(harness, request(tools=[{"name": "lookup", "description": "Find a value", "parameters": {"type": "object"}}]), profile())

        self.assertEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"], [event["type"] for event in events])
        self.assertEqual("call-1", events[1]["id"])
        self.assertEqual("lookup", events[1]["toolName"])
        self.assertEqual('{"q":"value"}', events[2]["delta"])
        self.assertEqual("toolUse", events[-1]["reason"])
        self.assertEqual(4, events[-1]["usage"]["input"])
        sent_body = json.loads(harness.requests[0].content)
        self.assertEqual("lookup", sent_body["tools"][0]["function"]["name"])
        self.assertEqual("auto", sent_body["tool_choice"])
        self.assertTrue(harness.streams[0].closed)

    def test_explicit_finish_reason_completes_without_optional_done_sentinel(self):
        harness = UpstreamHarness(200, sse(
            {"choices": [{"delta": {"content": "Complete"}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 3, "completion_tokens": 1}},
        ))

        events = self.collect(harness, request(), profile())

        self.assertEqual(["start", "text_start", "text_delta", "text_end", "done"], [event["type"] for event in events])
        self.assertEqual("Complete", events[2]["delta"])
        self.assertEqual("stop", events[-1]["reason"])
        self.assertEqual(3, events[-1]["usage"]["input"])

    def test_http_error_is_sse_error_without_upstream_body_or_secret(self):
        upstream_body = '{"error":{"message":"provider-secret body-secret Authorization: Bearer provider-secret"}}'
        harness = UpstreamHarness(401, [upstream_body.encode()])

        with self.assertLogs("prompt_agent.provider_proxy", level="INFO") as captured:
            events = self.collect(harness, request(), profile())

        self.assertEqual(["start", "error"], [event["type"] for event in events])
        self.assertEqual("Provider rejected the configured credentials (HTTP 401).", events[-1]["errorMessage"])
        emitted_and_logged = json.dumps(events) + "\n" + "\n".join(captured.output)
        for secret in ("provider-secret", "body-secret", "Authorization"):
            self.assertNotIn(secret, emitted_and_logged)
        self.assertIn("status=401", captured.output[0])
        self.assertIn("error_code=provider_auth_error", captured.output[0])
        self.assertTrue(harness.streams[0].closed)
        self.assertTrue(harness.client is not None and harness.client.is_closed)

    def test_malformed_and_unexpected_eof_are_sanitized(self):
        cases = (
            ([b"data: {not-json}\n\n"], "The provider returned an invalid streaming response.", "provider_malformed_response"),
            (sse({"choices": [{"delta": {"content": "partial"}}]}), "The provider stream ended before completion.", "provider_unexpected_eof"),
        )
        for chunks, message, code in cases:
            with self.subTest(code=code):
                harness = UpstreamHarness(200, chunks)
                with self.assertLogs("prompt_agent.provider_proxy", level="INFO") as captured:
                    events = self.collect(harness, request(), profile())
                self.assertEqual("error", events[-1]["type"])
                self.assertEqual(message, events[-1]["errorMessage"])
                self.assertIn(f"error_code={code}", captured.output[0])
                self.assertNotIn("not-json", json.dumps(events))
                self.assertTrue(harness.streams[0].closed)
                self.assertTrue(harness.client is not None and harness.client.is_closed)

    def test_downstream_cancellation_closes_upstream_stream_and_client(self):
        async def run() -> tuple[list[str], TrackingByteStream, httpx.AsyncClient]:
            started = asyncio.Event()
            release = asyncio.Event()
            harness = UpstreamHarness(200, [], started=started, release=release)
            generator = stream_profile(request("cancel-request"), profile())
            received = [json.loads((await anext(generator))[5:].strip())["type"]]

            async def consume() -> None:
                async for frame in generator:
                    received.append(json.loads(frame[5:].strip())["type"])

            with patch("backend.prompt_agent.providers.httpx.AsyncClient", new=harness.client_factory):
                task = asyncio.create_task(consume())
                await asyncio.wait_for(started.wait(), timeout=1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertIsNotNone(harness.client)
            self.assertEqual(1, len(harness.streams))
            return received, harness.streams[0], harness.client

        received, stream, client = asyncio.run(run())
        self.assertEqual(["start"], received)
        self.assertTrue(stream.closed)
        self.assertTrue(client.is_closed)


if __name__ == "__main__":
    unittest.main()
