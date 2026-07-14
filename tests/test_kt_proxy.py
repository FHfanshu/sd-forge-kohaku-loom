from __future__ import annotations

import json
import unittest

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kohaku_loom.kt_proxy import register_kt_proxy


class ChunkStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]):
        self.chunks = chunks
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


class FakeManager:
    def __init__(self, states: list[dict] | None = None, error: Exception | None = None):
        self.states = list(states or [{"port": 43123, "token": "internal-secret"}])
        self.error = error
        self.start_calls = 0

    def start(self):
        self.start_calls += 1
        if self.error is not None:
            raise self.error
        index = min(self.start_calls - 1, len(self.states) - 1)
        return self.states[index]


class FakeClient:
    def __init__(self, responses: list[httpx.Response | Exception], requests: list[httpx.Request], **kwargs):
        self.responses = responses
        self.requests = requests
        self.kwargs = kwargs
        self.closed = False

    def build_request(self, method, url, **kwargs):
        request = httpx.Request(method, url, **kwargs)
        self.requests.append(request)
        return request

    async def send(self, request, stream=False):
        del request, stream
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    async def aclose(self):
        self.closed = True


def proxy_app(manager: FakeManager, responses: list[httpx.Response | Exception]):
    requests: list[httpx.Request] = []
    clients: list[FakeClient] = []

    def client_factory(**kwargs):
        client = FakeClient(responses, requests, **kwargs)
        clients.append(client)
        return client

    app = FastAPI()
    register_kt_proxy(app, manager_factory=lambda: manager, client_factory=client_factory)
    return app, requests, clients


class KohakuTerrariumProxyTests(unittest.TestCase):
    def test_json_proxy_starts_lazily_and_overwrites_authorization(self):
        upstream = httpx.Response(
            200,
            headers={"content-type": "application/json"},
            content=b'{"ok":true}',
        )
        manager = FakeManager()
        app, requests, clients = proxy_app(manager, [upstream])
        self.assertEqual(0, manager.start_calls)

        with TestClient(app) as client:
            response = client.post(
                "/kohaku-loom/kt/turns?mode=test",
                headers={
                    "Authorization": "Bearer browser-secret",
                    "Content-Type": "application/json",
                    "Last-Event-ID": "12",
                },
                content=b'{"content":"hello"}',
            )

        self.assertEqual(200, response.status_code)
        self.assertEqual({"ok": True}, response.json())
        self.assertEqual(1, manager.start_calls)
        self.assertEqual("http://127.0.0.1:43123/turns?mode=test", str(requests[0].url))
        self.assertEqual("Bearer internal-secret", requests[0].headers["authorization"])
        self.assertEqual("12", requests[0].headers["last-event-id"])
        self.assertEqual(b'{"content":"hello"}', requests[0].content)
        self.assertTrue(clients[0].closed)
        self.assertNotIn("internal-secret", response.text)
        self.assertNotIn("43123", response.text)

    def test_sidecar_json_error_is_preserved(self):
        upstream = httpx.Response(
            409,
            headers={"content-type": "application/json"},
            content=b'{"detail":"A Loom turn is already active"}',
        )
        app, _, _ = proxy_app(FakeManager(), [upstream])

        with TestClient(app) as client:
            response = client.post("/kohaku-loom/kt/turns", json={"content": "hello"})

        self.assertEqual(409, response.status_code)
        self.assertEqual("A Loom turn is already active", response.json()["detail"])

    def test_sse_is_forwarded_without_reencoding(self):
        chunks = [
            b"id: 1\n",
            b"event: text_delta\n",
            b'data: {"text":"hi"}\n\n',
            b": keepalive\n\n",
        ]
        stream = ChunkStream(chunks)
        upstream = httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=stream,
        )
        app, requests, clients = proxy_app(FakeManager(), [upstream])

        with TestClient(app) as client:
            response = client.get(
                "/kohaku-loom/kt/turns/events?after=5",
                headers={"Last-Event-ID": "9"},
            )

        self.assertEqual(b"".join(chunks), response.content)
        self.assertTrue(response.headers["content-type"].startswith("text/event-stream"))
        self.assertEqual("no-cache, no-transform", response.headers["cache-control"])
        self.assertEqual("no", response.headers["x-accel-buffering"])
        self.assertEqual("9", requests[0].headers["last-event-id"])
        self.assertTrue(stream.closed)
        self.assertTrue(clients[0].closed)

    def test_connection_failure_restarts_once_without_disclosing_state(self):
        request = httpx.Request("GET", "http://127.0.0.1:43123/runtime")
        failure = httpx.ConnectError("failed to connect to 127.0.0.1:43123", request=request)
        recovered = httpx.Response(
            200,
            headers={"content-type": "application/json"},
            content=json.dumps({"active_session": None}).encode(),
        )
        manager = FakeManager(
            [
                {"port": 43123, "token": "first-secret"},
                {"port": 43124, "token": "second-secret"},
            ]
        )
        app, requests, _ = proxy_app(manager, [failure, recovered])

        with TestClient(app) as client:
            response = client.get("/kohaku-loom/kt/runtime")

        self.assertEqual(200, response.status_code)
        self.assertEqual(2, manager.start_calls)
        self.assertEqual("http://127.0.0.1:43123/runtime", str(requests[0].url))
        self.assertEqual("http://127.0.0.1:43124/runtime", str(requests[1].url))
        self.assertNotIn("first-secret", response.text)
        self.assertNotIn("second-secret", response.text)

    def test_startup_error_is_sanitized(self):
        manager = FakeManager(error=RuntimeError("token=secret port=43123"))
        app, _, _ = proxy_app(manager, [])

        with TestClient(app) as client:
            response = client.get("/kohaku-loom/kt/health")

        self.assertEqual(503, response.status_code)
        self.assertNotIn("secret", response.text)
        self.assertNotIn("43123", response.text)

    def test_dot_segments_are_rejected(self):
        app, _, _ = proxy_app(FakeManager(), [])

        with TestClient(app) as client:
            response = client.get("/kohaku-loom/kt/%2e%2e/health")

        self.assertIn(response.status_code, {404, 307})
