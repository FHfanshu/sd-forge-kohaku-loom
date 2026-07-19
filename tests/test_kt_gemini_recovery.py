from __future__ import annotations

import unittest
from unittest import mock

try:
    from kohaku_loom.kt_providers import GeminiNativeProvider

    KT_AVAILABLE = True
except (ImportError, ModuleNotFoundError):
    KT_AVAILABLE = False


class Stream:
    def __init__(self, responses):
        self.responses = list(responses)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.responses:
            return self.responses.pop(0)
        raise StopAsyncIteration


class Client:
    def __init__(self, responses, captured):
        self.aio = self
        self.models = self
        self.responses = responses
        self.captured = captured

    async def generate_content_stream(self, **kwargs):
        self.captured.append(kwargs)
        return Stream(self.responses)

    async def aclose(self):
        return None


@unittest.skipUnless(KT_AVAILABLE, "KohakuTerrarium sidecar dependency is not installed")
class GeminiNativeRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_stream_retries_with_sanitized_low_reasoning_input(self):
        empty = {"candidates": [{"finishReason": "SAFETY", "content": {"parts": []}}]}
        visible = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "Recovered"}]}}]}
        captured = []
        provider = GeminiNativeProvider({
            "model": "gemini-test",
            "endpoint": "https://primary.example",
            "api_key": "secret",
            "reasoning_effort": "high",
            "sanitize_sensitive": False,
        })
        provider._retry_delay = mock.AsyncMock()

        with mock.patch(
            "kohaku_loom.kt_providers._gemini_client",
            side_effect=[Client([empty], captured), Client([visible], captured)],
        ):
            chunks = [chunk async for chunk in provider.chat([
                {"role": "user", "content": "Describe a nude portrait"},
            ])]

        self.assertEqual(["Recovered"], chunks)
        self.assertIn("nude", str(captured[0]["contents"]))
        self.assertNotIn("nude", str(captured[1]["contents"]))
        self.assertIn("SAFE_SLOT_001", str(captured[1]["contents"]))
        self.assertEqual("LOW", captured[1]["config"].thinking_config.thinking_level.value)
        provider._retry_delay.assert_awaited_once()

    async def test_repeated_empty_streams_fail_instead_of_completing_silently(self):
        empty = {"candidates": [{"finishReason": "SAFETY", "content": {"parts": []}}]}
        captured = []
        provider = GeminiNativeProvider({
            "model": "gemini-test",
            "endpoint": "https://primary.example",
            "api_key": "secret",
        })
        provider._retry_delay = mock.AsyncMock()

        with mock.patch(
            "kohaku_loom.kt_providers._gemini_client",
            side_effect=[Client([empty], captured) for _ in range(6)],
        ):
            with self.assertRaisesRegex(RuntimeError, "empty visible output"):
                _ = [chunk async for chunk in provider.chat([{"role": "user", "content": "hello"}])]

        self.assertEqual(6, len(captured))
        self.assertEqual(5, provider._retry_delay.await_count)


if __name__ == "__main__":
    unittest.main()
