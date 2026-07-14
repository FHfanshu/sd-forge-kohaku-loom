from __future__ import annotations

import json
import asyncio
import os
import tempfile
import types
import unittest
from pathlib import Path
from subprocess import CalledProcessError
from unittest import mock

from fastapi.testclient import TestClient

from kohaku_loom.dpapi import protect_text, unprotect_text
from kohaku_loom.profile_store import LoomProfileStore
from kohaku_loom.response_text import reasoning_text
from kohaku_loom.runtime_paths import LoomRuntimePaths
from kohaku_loom.sidecar_manager import SidecarManager
from kohaku_loom.sidecar.runtime import LoomSidecarRuntime
from kohaku_loom.sidecar.app import create_app


def profile_state(api_key: str = "secret-value") -> dict:
    return {
        "active_profile_id": "remote",
        "teacher_profile_id": "remote",
        "session_profile_id": "local",
        "profiles": [
            {
                "id": "remote",
                "display_name": "Remote",
                "enabled": True,
                "protocol": "openai-chat-completions",
                "runtime": "remote-http",
                "endpoint": "https://example.com/v1",
                "model_id": "example-model",
                "api_key": api_key,
                "fallback_endpoints": [],
                "capabilities": {"tools": True, "vision": False, "streaming": True, "reasoning": True},
                "parameters": {"temperature": 0.3, "top_p": 0.9, "max_tokens": 1024, "timeout": 60},
            },
            {
                "id": "local",
                "display_name": "Local",
                "enabled": True,
                "protocol": "openai-chat-completions",
                "runtime": "llama-once",
                "model_id": "local-model",
                "api_key": "",
                "model_path": "C:\\models\\model.gguf",
                "fallback_endpoints": [],
                "capabilities": {"tools": True, "vision": True, "streaming": True, "reasoning": True},
                "parameters": {"temperature": 0.2, "top_p": 0.9, "max_tokens": 1024, "timeout": 60},
            },
        ],
    }


class RuntimePathTests(unittest.TestCase):
    def test_runtime_paths_stay_under_extension_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = LoomRuntimePaths.under(root).ensure()
            self.assertEqual(root / ".loom", paths.root)
            self.assertTrue(paths.sessions.is_dir())
            self.assertEqual(paths.venv / "Scripts" / "python.exe", paths.python)


@unittest.skipUnless(os.name == "nt", "Windows DPAPI only")
class DpapiTests(unittest.TestCase):
    def test_dpapi_round_trip(self):
        encrypted = protect_text("local secret")
        self.assertNotIn("local secret", encrypted)
        self.assertEqual("local secret", unprotect_text(encrypted))


class ProfileStoreTests(unittest.TestCase):
    def test_import_separates_public_profiles_and_encrypted_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory))
            with mock.patch("kohaku_loom.profile_store.protect_text", return_value="encrypted"):
                store = LoomProfileStore(paths)
                state = store.import_state(profile_state())
            self.assertTrue(state["profiles"][0]["has_api_key"])
            self.assertNotIn("api_key", state["profiles"][0])
            self.assertNotIn("secret-value", paths.profiles_file.read_text(encoding="utf-8"))
            self.assertEqual(
                {"remote": "encrypted"},
                json.loads(paths.profile_secrets_file.read_text(encoding="utf-8")),
            )

    def test_resolve_decrypts_only_requested_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory))
            with mock.patch("kohaku_loom.profile_store.protect_text", return_value="encrypted"):
                store = LoomProfileStore(paths)
                store.import_state(profile_state())
            with mock.patch("kohaku_loom.profile_store.unprotect_text", return_value="secret-value") as decrypt:
                profile = store.resolve("remote")
            self.assertEqual("secret-value", profile["api_key"])
            decrypt.assert_called_once_with("encrypted")

    def test_import_rejects_unknown_selected_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            state = profile_state("")
            state["active_profile_id"] = "missing"
            store = LoomProfileStore(LoomRuntimePaths.under(Path(directory)))
            with self.assertRaisesRegex(ValueError, "active_profile_id"):
                store.import_state(state)

    def test_reimport_preserves_existing_encrypted_key_when_browser_only_knows_it_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory))
            with mock.patch("kohaku_loom.profile_store.protect_text", return_value="encrypted"):
                store = LoomProfileStore(paths)
                store.import_state(profile_state())
            scrubbed = profile_state("")
            scrubbed["profiles"][0]["has_api_key"] = True
            store.import_state(scrubbed)

            self.assertEqual(
                {"remote": "encrypted"},
                json.loads(paths.profile_secrets_file.read_text(encoding="utf-8")),
            )


class SidecarManagerTests(unittest.TestCase):
    def test_stable_kohakuterrarium_is_kept_when_capability_probe_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = SidecarManager(Path(directory))
            with (
                mock.patch.object(manager, "_probe_kohakuterrarium", return_value="2.1.0"),
                mock.patch("kohaku_loom.sidecar_manager.subprocess.run") as run,
            ):
                source, commit = manager._install_kohakuterrarium()

        self.assertEqual(("pypi", ""), (source, commit))
        self.assertIn("--force-reinstall", run.call_args.args[0])
        self.assertEqual("KohakuTerrarium", run.call_args.args[0][-1])

    def test_missing_stable_capabilities_fall_back_to_exact_main_commit(self):
        commit = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            manager = SidecarManager(Path(directory))
            with (
                mock.patch.object(
                    manager,
                    "_probe_kohakuterrarium",
                    side_effect=[CalledProcessError(1, "probe"), "2.1.0.dev0"],
                ),
                mock.patch.object(manager, "_latest_main_commit", return_value=commit),
                mock.patch("kohaku_loom.sidecar_manager.subprocess.run") as run,
            ):
                source, locked_commit = manager._install_kohakuterrarium()

        self.assertEqual(("github-main", commit), (source, locked_commit))
        fallback = run.call_args_list[1].args[0]
        self.assertEqual(
            f"git+https://github.com/Kohaku-Lab/KohakuTerrarium.git@{commit}",
            fallback[-1],
        )

    @mock.patch("kohaku_loom.sidecar_manager.os.name", "nt")
    def test_environment_install_uses_plugin_local_config_and_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager = SidecarManager(root)
            manager.paths.python.parent.mkdir(parents=True)
            manager.paths.python.touch()
            with (
                mock.patch.object(manager, "_install_kohakuterrarium", return_value=("github-main", "b" * 40)),
                mock.patch.object(manager, "_probe_kohakuterrarium", return_value="2.1.0.dev0"),
                mock.patch("kohaku_loom.sidecar_manager.subprocess.run") as run,
            ):
                lock = manager.ensure_environment()

        self.assertEqual("github-main", lock["source"])
        package_install = run.call_args_list[1]
        self.assertEqual(str(manager.paths.config), package_install.kwargs["env"]["KT_CONFIG_DIR"])
        self.assertEqual(str(manager.paths.sessions), package_install.kwargs["env"]["KT_SESSION_DIR"])

    def test_legacy_ready_lock_is_not_trusted(self):
        self.assertFalse(
            SidecarManager._lock_is_valid({"ready": True, "kohakuterrarium_version": "2.0.0"})
        )


class SidecarRuntimeUnitTests(unittest.IsolatedAsyncioTestCase):
    def test_reasoning_text_normalizes_provider_fields(self):
        self.assertEqual("chain", reasoning_text({"reasoning_content": "chain"}))
        self.assertEqual(
            "firstsecond",
            reasoning_text({"reasoning_details": [{"text": "first"}, {"thinking": "second"}]}),
        )

    async def test_profile_chat_uses_resolved_provider_and_closes_it(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            provider = mock.Mock()
            provider.config.model = "test-model"
            provider.last_usage = {"total_tokens": 3}
            provider.begin_turn = mock.AsyncMock()
            provider.end_turn = mock.AsyncMock()
            provider.close = mock.AsyncMock()
            provider.chat_complete = mock.AsyncMock(
                return_value=mock.Mock(content="pong", model="test-model", usage={"total_tokens": 3})
            )
            runtime._build_provider = mock.Mock(return_value=provider)

            result = await runtime.profile_chat("profile", [{"role": "user", "content": "ping"}])

        self.assertEqual("pong", result["text"])
        provider.begin_turn.assert_awaited_once()
        provider.end_turn.assert_awaited_once()
        provider.close.assert_awaited_once()
    async def test_active_session_conversation_is_serializable(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            conversation = mock.Mock()
            conversation.to_messages.return_value = [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "world"},
            ]
            runtime.active = mock.Mock(
                session_id="unit",
                profile_id="profile",
                path=paths.sessions / "unit.kohakutr",
                resumed=True,
                opened_at=1.0,
            )
            runtime.active.creature.agent.controller.conversation = conversation

            result = runtime.session_conversation("unit")

        self.assertEqual("unit", result["session"]["session_id"])
        self.assertEqual("world", result["messages"][1]["content"])
        conversation.to_messages.assert_called_once_with(preserve_pending_tail=True)

    async def test_turn_runs_independently_of_event_subscription(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            finished = asyncio.Event()

            class Agent:
                def interrupt(self):
                    return None

            class Creature:
                agent = Agent()

                async def run_stream(self, content, **kwargs):
                    del content, kwargs
                    await asyncio.sleep(0.02)
                    finished.set()
                    if False:
                        yield None

            runtime.active = mock.Mock(
                session_id="unit",
                profile_id="profile",
                path=paths.sessions / "unit.kohakutr",
                engine=mock.Mock(),
                creature=Creature(),
                provider=object(),
                resumed=False,
                opened_at=0.0,
            )
            fake_kt = types.ModuleType("kohakuterrarium")
            fake_kt.Activity = type("Activity", (), {})
            fake_kt.TextChunk = type("TextChunk", (), {})
            fake_kt.TurnEnded = type("TurnEnded", (), {})
            with mock.patch.dict("sys.modules", {"kohakuterrarium": fake_kt}):
                accepted = await runtime.start_turn("hello")
                await asyncio.wait_for(finished.wait(), timeout=1)
                await asyncio.wait_for(runtime._turn_task, timeout=1)

        self.assertEqual("accepted", accepted["status"])
        event_types = [event["type"] for event in runtime.events.after(0)]
        self.assertIn("turn_started", event_types)

    async def test_turn_publishes_reasoning_and_usage_events(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())

            class TextChunk:
                def __init__(self, text):
                    self.text = text

            class Activity:
                def __init__(self, kind, metadata):
                    self.kind = kind
                    self.detail = ""
                    self.metadata = metadata

            class TurnEnded:
                def __init__(self, result):
                    self.result = result

            class Provider:
                last_assistant_extra_fields = {"reasoning_content": "final thought"}

                def set_stream_observer(self, observer):
                    self.observer = observer

            provider = Provider()

            class Agent:
                def interrupt(self):
                    return None

            class Creature:
                agent = Agent()

                async def run_stream(self, content, **kwargs):
                    del content, kwargs
                    await provider.observer("reasoning_delta", {"text": "live thought"})
                    yield TextChunk("answer")
                    yield Activity("token_usage", {"prompt_tokens": 8, "completion_tokens": 2})
                    yield TurnEnded(
                        mock.Mock(
                            status="ok",
                            text="answer",
                            error=None,
                            usage={"prompt_tokens": 8, "completion_tokens": 2},
                            duration_s=0.1,
                            interrupted_by_user=False,
                        )
                    )

            runtime.active = mock.Mock(
                session_id="unit",
                profile_id="profile",
                path=paths.sessions / "unit.kohakutr",
                engine=mock.Mock(),
                creature=Creature(),
                provider=provider,
                resumed=False,
                opened_at=0.0,
            )
            fake_kt = types.ModuleType("kohakuterrarium")
            fake_kt.Activity = Activity
            fake_kt.TextChunk = TextChunk
            fake_kt.TurnEnded = TurnEnded
            with mock.patch.dict("sys.modules", {"kohakuterrarium": fake_kt}):
                await runtime.start_turn("hello")
                await asyncio.wait_for(runtime._turn_task, timeout=1)

        events = runtime.events.after(0)
        self.assertTrue(any(event["type"] == "reasoning_delta" for event in events))
        self.assertTrue(any(event["type"] == "reasoning_snapshot" for event in events))
        self.assertTrue(any(event["type"] == "usage" for event in events))

    async def test_second_active_session_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = mock.Mock(session_id="active")
            with self.assertRaisesRegex(RuntimeError, "already active"):
                await runtime.open_session("profile", provider=mock.Mock())


class SidecarApiTests(unittest.TestCase):
    def test_runtime_routes_require_token_and_forward_turns(self):
        class FakeRuntime:
            has_active_turn = False

            def __init__(self):
                self.events = mock.Mock()
                self.events.subscribe = mock.Mock()

            def status(self):
                return {
                    "active_session": None,
                    "active_turn_id": "",
                    "turn_event_sequence": 0,
                    "tool_event_sequence": 0,
                }

            def list_sessions(self):
                return []

            def session_conversation(self, session_id):
                return {"session": {"session_id": session_id}, "messages": []}

            async def start_turn(self, content, timeout):
                return {"turn_id": "turn-1", "status": "accepted", "content": content, "timeout": timeout}

            async def profile_chat(self, profile_id, messages):
                return {"ok": True, "profile_id": profile_id, "text": messages[0]["content"]}

            async def close(self):
                return None

        with tempfile.TemporaryDirectory() as directory:
            runtime = FakeRuntime()
            app, _ = create_app(
                "secret-token",
                LoomRuntimePaths.under(Path(directory)),
                runtime=runtime,
            )
            with TestClient(app) as client:
                self.assertEqual(401, client.get("/runtime").status_code)
                response = client.post(
                    "/turns",
                    headers={"Authorization": "Bearer secret-token"},
                    json={"content": "hello", "timeout": 30},
                )
                history = client.get(
                    "/sessions/session-1",
                    headers={"Authorization": "Bearer secret-token"},
                )
                profile_chat = client.post(
                    "/profiles/remote/chat",
                    headers={"Authorization": "Bearer secret-token"},
                    json={"messages": [{"role": "user", "content": "ping"}]},
                )

        self.assertEqual(200, response.status_code)
        self.assertEqual("turn-1", response.json()["turn_id"])
        self.assertEqual(30.0, response.json()["timeout"])
        self.assertEqual("session-1", history.json()["session"]["session_id"])
        self.assertEqual("ping", profile_chat.json()["text"])


if __name__ == "__main__":
    unittest.main()
