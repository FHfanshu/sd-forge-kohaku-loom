from __future__ import annotations

import asyncio
import ctypes
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx

from backend.prompt_agent import API_PREFIX, register_prompt_agent_api
from backend.prompt_agent.profiles import ProfileAuthority, default_storage_root
from backend.prompt_agent.providers import public_profile_state
from backend.prompt_agent import secrets
from backend.prompt_agent.profile_connection import ConnectionTestError, test_profile_connection


class PromptAgentApiTests(unittest.TestCase):
    def test_health_reports_frontend_runtime_contract(self):
        app = FastAPI()
        register_prompt_agent_api(app)
        register_prompt_agent_api(app)

        response = TestClient(app).get(f"{API_PREFIX}/health")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["service"], "SD Forge Neo Prompt Agent")
        self.assertEqual(payload["runtime"], "frontend-pi")
        self.assertEqual(payload["session_storage"], "indexeddb")
        self.assertEqual(len([route for route in app.routes if route.path == f"{API_PREFIX}/health"]), 1)
        self.assertEqual(payload["features"]["agent_loop"], True)
        self.assertEqual(payload["features"]["provider_proxy"], True)

    def test_profiles_never_return_secret_or_local_paths(self):
        app = FastAPI()
        register_prompt_agent_api(app)
        state = {
            "profiles": [{
                "profile_id": "remote",
                "model_id": "model",
                "endpoint": "https://provider.invalid/v1",
                "fallback_endpoints": ["https://fallback.invalid/v1"],
                "api_key": "secret",
                "model_path": "C:/private/model.gguf",
                "mmproj_path": "C:/private/mmproj.gguf",
                "llama_server_path": "C:/private/llama-server.exe",
            }],
        }
        projected = public_profile_state(state)
        serialized = str(projected)
        for forbidden in ("secret", "provider.invalid", "C:/private"):
            self.assertNotIn(forbidden, serialized)

    def test_profile_authority_projects_local_paths_as_configuration_flags(self):
        with TemporaryDirectory() as directory:
            authority = ProfileAuthority(Path(directory))
            created = authority.create({
                "id": "local-once",
                "displayName": "Local once",
                "modelId": "model",
                "protocol": "openai-chat-completions",
                "runtime": "llama-once",
                "model_path": "C:/private/model.gguf",
                "mmproj_path": "C:/private/mmproj.gguf",
                "llama_server_path": "C:/private/llama-server.exe",
            })

            self.assertTrue(created["localModelConfigured"])
            self.assertTrue(created["mmprojConfigured"])
            self.assertTrue(created["llamaServerConfigured"])
            serialized = str(created)
            self.assertNotIn("C:/private", serialized)
            self.assertNotIn("modelPath", created)
            self.assertNotIn("mmprojPath", created)
            self.assertNotIn("llamaServerPath", created)

    def test_stream_rejects_browser_owned_provider_fields(self):
        app = FastAPI()
        register_prompt_agent_api(app)
        payload = {
            "profile_id": "remote",
            "request_id": "request-1",
            "api_key": "must-not-pass",
            "context": {"messages": [{"role": "user", "content": "Hi", "timestamp": 1}]},
        }
        response = TestClient(app).post(f"{API_PREFIX}/stream", json=payload)
        self.assertEqual(response.status_code, 422)

    def test_profile_crud_routes_persist_without_returning_plaintext_secret(self):
        with TemporaryDirectory() as directory:
            app = FastAPI()
            register_prompt_agent_api(app, ProfileAuthority(Path(directory)))
            with (
                patch("backend.prompt_agent.profiles.protect_text", return_value="encrypted"),
                patch("backend.prompt_agent.profiles.unprotect_text", return_value="secret-value"),
            ):
                client = TestClient(app)
                payload = {
                    "id": "remote",
                    "displayName": "Remote",
                    "modelId": "model",
                    "enabled": True,
                    "protocol": "openai-chat-completions",
                    "runtime": "remote-http",
                    "endpoint": "https://provider.invalid/v1",
                    "api_key": "secret-value",
                }

                created = client.post(f"{API_PREFIX}/profiles", json=payload)
                self.assertEqual(created.status_code, 200)
                self.assertTrue(created.json()["hasApiKey"])
                self.assertIn("topP", created.json()["parameters"])
                self.assertNotIn("top_p", created.json()["parameters"])
                self.assertNotIn("secret-value", created.text)

                patched = client.patch(f"{API_PREFIX}/profiles/remote", json={"display_name": "Updated"})
                self.assertEqual("Updated", patched.json()["displayName"])
                duplicated = client.post(f"{API_PREFIX}/profiles/remote/duplicate")
                self.assertEqual(duplicated.status_code, 200)
                duplicate_id = duplicated.json()["id"]
                routed = client.post(f"{API_PREFIX}/profile-routes/default", json={"role": "active", "profile_id": duplicate_id})
                self.assertEqual(duplicate_id, routed.json()["activeProfileId"])
                deleted = client.delete(f"{API_PREFIX}/profiles/{duplicate_id}")
                self.assertEqual(deleted.status_code, 204)

                restored = client.post(f"{API_PREFIX}/profiles/restore-defaults")
                self.assertEqual(restored.status_code, 200)
                self.assertEqual("local-endpoint", restored.json()["activeProfileId"])
                self.assertFalse(any(profile["hasApiKey"] for profile in restored.json()["profiles"]))

    def test_default_profile_storage_never_uses_dot_loom(self):
        path = default_storage_root()
        self.assertEqual("prompt-agent", path.name)
        self.assertNotIn(".loom", path.parts)

    def test_models_api_returns_safe_metadata_only(self):
        with TemporaryDirectory() as directory:
            authority = ProfileAuthority(Path(directory))
            with patch("backend.prompt_agent.profiles.protect_text", return_value="encrypted"):
                authority.create({
                    "id": "remote",
                    "displayName": "Remote",
                    "modelId": "safe-model",
                    "protocol": "openai-chat-completions",
                    "runtime": "remote-http",
                    "endpoint": "https://provider.invalid/v1",
                    "api_key": "secret-value",
                })
                authority.create({
                    "id": "local",
                    "displayName": "Local",
                    "modelId": "local-model",
                    "protocol": "openai-chat-completions",
                    "runtime": "llama-once",
                    "enabled": False,
                    "model_path": "C:/private/model.gguf",
                    "mmproj_path": "C:/private/mmproj.gguf",
                    "llama_server_path": "C:/private/llama-server.exe",
                })
            app = FastAPI()
            register_prompt_agent_api(app, authority)
            response = TestClient(app).get(f"{API_PREFIX}/models")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual({"version", "models"}, set(payload))
            serialized = response.text
            for forbidden in ("secret-value", "C:/private", "model_path", "mmproj_path", "llama_server_path"):
                self.assertNotIn(forbidden, serialized)
            remote = next(item for item in payload["models"] if item["id"] == "remote")
            self.assertEqual("safe-model", remote["modelId"])
            self.assertTrue(remote["hasApiKey"])
            self.assertFalse(remote["localModelConfigured"])

    def test_import_api_is_idempotent_and_does_not_discover_loom(self):
        with TemporaryDirectory() as directory:
            authority = ProfileAuthority(Path(directory))
            app = FastAPI()
            register_prompt_agent_api(app, authority)
            payload = {
                "active_profile_id": "remote",
                "profiles": [{
                    "id": "remote",
                    "display_name": "Remote",
                    "model_id": "model",
                    "protocol": "openai-chat-completions",
                    "runtime": "remote-http",
                    "endpoint": "https://provider.invalid/v1",
                    "api_key": "secret-value",
                }],
            }
            with patch("backend.prompt_agent.profiles.protect_text", return_value="encrypted"):
                client = TestClient(app)
                first = client.post(f"{API_PREFIX}/profiles/import", json=payload)
                second = client.post(f"{API_PREFIX}/profiles/import", json=payload)

            self.assertEqual(first.status_code, 200)
            self.assertEqual(second.status_code, 200)
            self.assertEqual(len(first.json()["profiles"]), len(second.json()["profiles"]))
            self.assertEqual(1, sum(item["id"] == "remote" for item in second.json()["profiles"]))
            self.assertEqual("remote", second.json()["activeProfileId"])
            self.assertNotIn(".loom", str(authority.root))

    def test_import_preserves_an_existing_protected_key_when_snapshot_has_only_marker(self):
        with TemporaryDirectory() as directory:
            authority = ProfileAuthority(Path(directory))
            payload = {
                "profiles": [{
                    "id": "remote",
                    "display_name": "Remote",
                    "model_id": "model",
                    "protocol": "openai-chat-completions",
                    "runtime": "remote-http",
                    "endpoint": "https://provider.invalid/v1",
                    "api_key": "secret-value",
                }],
            }
            with patch("backend.prompt_agent.profiles.protect_text", return_value="encrypted"):
                authority.import_legacy_state(payload)
            scrubbed = {
                "profiles": [{**payload["profiles"][0], "has_api_key": True}],
            }
            with patch("backend.prompt_agent.profiles.unprotect_text", return_value="secret-value"):
                result = authority.import_legacy_state(scrubbed)
            self.assertTrue(result["profiles"][0]["hasApiKey"])

    def test_crud_and_default_routes_survive_a_fresh_authority(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch("backend.prompt_agent.profiles.protect_text", return_value="encrypted"),
                patch("backend.prompt_agent.profiles.unprotect_text", return_value="secret-value"),
            ):
                first = ProfileAuthority(root)
                first.create({
                    "id": "remote",
                    "displayName": "Remote",
                    "modelId": "model",
                    "protocol": "openai-chat-completions",
                    "runtime": "remote-http",
                    "endpoint": "https://provider.invalid/v1",
                    "api_key": "secret-value",
                })
                first.update("remote", {"display_name": "Persisted"})
                first.set_default("active", "remote")
                duplicate = first.duplicate("remote")
                first.delete(duplicate["id"])

            second = ProfileAuthority(root)
            state = second.list_state()
            remote = second.get("remote")
            self.assertEqual("remote", state["activeProfileId"])
            self.assertEqual("Persisted", remote["displayName"])
            self.assertEqual(2, len(state["profiles"]))
            self.assertTrue(remote["hasApiKey"])
            self.assertNotIn("secret-value", str(state))

    def test_llama_once_cannot_be_selected_as_the_active_agent_profile(self):
        with TemporaryDirectory() as directory:
            authority = ProfileAuthority(Path(directory))
            authority.create({
                "id": "one-shot",
                "displayName": "One shot",
                "modelId": "local-model",
                "protocol": "openai-chat-completions",
                "runtime": "llama-once",
                "model_path": "C:/models/local-model.gguf",
            })
            with self.assertRaisesRegex(ValueError, "agent streaming"):
                authority.set_default("active", "one-shot")
            with self.assertRaisesRegex(ValueError, "agent streaming"):
                authority.set_default("teacher", "one-shot")

    def test_openai_connection_test_performs_bounded_models_request(self):
        calls: list[tuple[str, dict[str, str]]] = []

        class Response:
            def raise_for_status(self):
                return None

        class Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def get(self, url, **kwargs):
                calls.append((url, kwargs["headers"]))
                return Response()

        profile = {
            "id": "remote",
            "modelId": "model",
            "protocol": "openai-chat-completions",
            "runtime": "remote-http",
            "endpoint": "https://provider.invalid/v1",
            "api_key": "secret-value",
        }
        with patch("backend.prompt_agent.profile_connection.httpx.AsyncClient", return_value=Client()):
            result = asyncio.run(test_profile_connection(profile))

        self.assertTrue(result["ok"])
        self.assertTrue(calls[0][0].endswith("/v1/models"))
        self.assertEqual("Bearer secret-value", calls[0][1]["Authorization"])
        self.assertLessEqual(result["endpoint_index"], 0)

    def test_gemini_connection_test_uses_native_model_metadata_request(self):
        calls: list[tuple[str, dict[str, str]]] = []

        class Response:
            def raise_for_status(self):
                return None

        class Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def get(self, url, **kwargs):
                calls.append((url, kwargs["params"]))
                return Response()

        profile = {
            "id": "gemini",
            "modelId": "gemini-2.5-flash",
            "protocol": "gemini-native",
            "runtime": "remote-http",
            "endpoint": "https://generativelanguage.googleapis.com",
            "api_key": "secret-value",
        }
        with patch("backend.prompt_agent.profile_connection.httpx.AsyncClient", return_value=Client()):
            result = asyncio.run(test_profile_connection(profile))

        self.assertTrue(result["ok"])
        self.assertIn("/v1beta/models/gemini-2.5-flash", calls[0][0])
        self.assertEqual({"key": "secret-value"}, calls[0][1])

    def test_connection_cancellation_closes_http_client(self):
        closed = False

        class Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                nonlocal closed
                closed = True
                return False

            async def get(self, *_args, **_kwargs):
                raise asyncio.CancelledError()

        profile = {
            "id": "remote",
            "modelId": "model",
            "protocol": "openai-chat-completions",
            "runtime": "remote-http",
            "endpoint": "https://provider.invalid/v1",
        }
        with patch("backend.prompt_agent.profile_connection.httpx.AsyncClient", return_value=Client()):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(test_profile_connection(profile))
        self.assertTrue(closed)

    def test_connection_errors_are_sanitized(self):
        class Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def get(self, *_args, **_kwargs):
                raise httpx.ConnectError("secret-value https://private.invalid")

        profile = {
            "id": "remote",
            "modelId": "model",
            "protocol": "openai-chat-completions",
            "runtime": "remote-http",
            "endpoint": "https://private.invalid/v1",
        }
        with patch("backend.prompt_agent.profile_connection.httpx.AsyncClient", return_value=Client()):
            with self.assertRaisesRegex(Exception, "could not be reached") as raised:
                asyncio.run(test_profile_connection(profile))
        self.assertNotIn("secret-value", str(raised.exception))
        self.assertNotIn("private.invalid", str(raised.exception))

    def test_connection_test_route_returns_probe_result_without_secret(self):
        with TemporaryDirectory() as directory:
            authority = ProfileAuthority(Path(directory))
            with (
                patch("backend.prompt_agent.profiles.protect_text", return_value="encrypted"),
                patch("backend.prompt_agent.profiles.unprotect_text", return_value="secret-value"),
            ):
                authority.create({
                    "id": "remote",
                    "modelId": "model",
                    "protocol": "openai-chat-completions",
                    "runtime": "remote-http",
                    "endpoint": "https://provider.invalid/v1",
                    "api_key": "secret-value",
                })
                app = FastAPI()
                register_prompt_agent_api(app, authority)
                with patch(
                    "backend.prompt_agent.app.test_profile_connection",
                    new=AsyncMock(return_value={
                        "ok": True,
                        "profile_id": "remote",
                        "model": "model",
                        "protocol": "openai-chat-completions",
                        "runtime": "remote-http",
                        "transport": "openai-compatible model catalog",
                        "endpoint_index": 0,
                    }),
                ) as probe:
                    response = TestClient(app).post(f"{API_PREFIX}/profiles/remote/connection-test")

            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json()["ok"])
            self.assertNotIn("secret-value", response.text)
            probe.assert_awaited_once()

    def test_connection_test_route_sanitizes_probe_failure(self):
        with TemporaryDirectory() as directory:
            authority = ProfileAuthority(Path(directory))
            authority.create({
                "id": "remote",
                "modelId": "model",
                "protocol": "openai-chat-completions",
                "runtime": "remote-http",
                "endpoint": "https://provider.invalid/v1",
            })
            app = FastAPI()
            register_prompt_agent_api(app, authority)
            failure = ConnectionTestError("connection_failed", "Provider request failed (HTTP 401).")
            with patch("backend.prompt_agent.app.test_profile_connection", new=AsyncMock(side_effect=failure)):
                response = TestClient(app).post(f"{API_PREFIX}/profiles/remote/connection-test")

            self.assertEqual(response.status_code, 502)
            self.assertEqual("connection_failed", response.json()["detail"]["error"]["code"])
            self.assertNotIn("api_key", response.text)

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI is unavailable")
    def test_dpapi_round_trip_on_windows(self):
        value = "phase7-dpapi-round-trip"
        protected = secrets.protect_text(value)
        self.assertNotEqual(value, protected)
        self.assertEqual(value, secrets.unprotect_text(protected))

    def test_dpapi_round_trip_uses_mocked_windows_boundary_on_ci(self):
        allocations: list[ctypes.Array] = []

        class Function:
            def __init__(self, callback):
                self.callback = callback
                self.argtypes = None
                self.restype = None

            def __call__(self, *args):
                return self.callback(*args)

        def protect(source_pointer, _description, _entropy, _reserved, _prompt, _flags, output_pointer):
            source = source_pointer._obj
            data = b"encrypted:" + ctypes.string_at(source.pbData, source.cbData)
            buffer = ctypes.create_string_buffer(data)
            allocations.append(buffer)
            output = output_pointer._obj
            output.cbData = len(data)
            output.pbData = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))
            return 1

        def unprotect(source_pointer, _description, _entropy, _reserved, _prompt, _flags, output_pointer):
            source = source_pointer._obj
            data = ctypes.string_at(source.pbData, source.cbData).removeprefix(b"encrypted:")
            buffer = ctypes.create_string_buffer(data)
            allocations.append(buffer)
            output = output_pointer._obj
            output.cbData = len(data)
            output.pbData = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))
            return 1

        fake_crypt32 = type("Crypt32", (), {
            "CryptProtectData": Function(protect),
            "CryptUnprotectData": Function(unprotect),
        })()
        fake_kernel32 = type("Kernel32", (), {"LocalFree": Function(lambda _pointer: 0)})()
        with patch.object(secrets, "_require_windows"), patch.object(secrets, "_libraries", return_value=(fake_crypt32, fake_kernel32)):
            value = "mocked-dpapi-round-trip"
            protected = secrets.protect_text(value)
            self.assertEqual(value, secrets.unprotect_text(protected))


if __name__ == "__main__":
    unittest.main()
