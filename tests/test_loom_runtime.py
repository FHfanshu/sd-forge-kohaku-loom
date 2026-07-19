from __future__ import annotations

import json
import asyncio
import os
import sys
import subprocess
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from kohaku_loom.dpapi import protect_text, unprotect_text
from kohaku_loom.profile_store import LoomProfileStore
from kohaku_loom.response_text import reasoning_text
from kohaku_loom.runtime_paths import LoomRuntimePaths
from kohaku_loom.sidecar_manager import KOHakuTERRARIUM_COMMIT, SidecarManager, _run_subprocess
from kohaku_loom.sidecar.message_queue import LoomMessageQueue
from kohaku_loom.sidecar.runtime import LoomSidecarRuntime
from kohaku_loom.sidecar.app import create_app


def profile_state(api_key: str = "secret-value") -> dict:
    return {
        "active_profile_id": "remote",
        "teacher_profile_id": "remote",
        "session_profile_id": "local",
        "naming_profile_id": "local",
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
            self.assertEqual("local", state["naming_profile_id"])
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

    def test_import_rejects_non_once_naming_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            state = profile_state("")
            state["naming_profile_id"] = "remote"
            store = LoomProfileStore(LoomRuntimePaths.under(Path(directory)))
            with self.assertRaisesRegex(ValueError, "naming_profile_id.*llama-once"):
                store.import_state(state)

    def test_import_accepts_disabled_profiles_without_runtime_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            state = profile_state("")
            state["profiles"][0]["enabled"] = False
            state["profiles"][0]["endpoint"] = ""
            state["active_profile_id"] = "local"
            state["teacher_profile_id"] = "local"
            store = LoomProfileStore(LoomRuntimePaths.under(Path(directory)))

            imported = store.import_state(state)

        self.assertEqual("local", imported["active_profile_id"])
        self.assertFalse(next(item for item in imported["profiles"] if item["profile_id"] == "remote")["enabled"])

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

    def test_import_does_not_persist_phantom_api_key_flag_without_a_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory))
            state = profile_state("")
            state["profiles"][0]["has_api_key"] = True

            imported = LoomProfileStore(paths).import_state(state)
            public = json.loads(paths.profiles_file.read_text(encoding="utf-8"))

            self.assertFalse(imported["profiles"][0]["has_api_key"])
            self.assertNotIn("has_api_key", public["profiles"][0])
            self.assertEqual({}, json.loads(paths.profile_secrets_file.read_text(encoding="utf-8")))


class SidecarManagerTests(unittest.TestCase):
    def test_stable_kohakuterrarium_is_kept_when_capability_probe_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = SidecarManager(Path(directory))
            with (
                mock.patch.object(manager, "_probe_kohakuterrarium", return_value="2.1.0"),
                mock.patch("kohaku_loom.sidecar_manager.subprocess.run") as run,
            ):
                source, commit = manager._install_kohakuterrarium()

        self.assertEqual(("github-pinned", KOHakuTERRARIUM_COMMIT), (source, commit))
        self.assertIn("--force-reinstall", run.call_args.args[0])
        self.assertIn("--no-deps", run.call_args.args[0])
        self.assertEqual(f"git+https://github.com/Kohaku-Lab/KohakuTerrarium.git@{KOHakuTERRARIUM_COMMIT}", run.call_args.args[0][-1])

    def test_pinned_install_does_not_resolve_a_mutable_main_branch(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = SidecarManager(Path(directory))
            with (
                mock.patch.object(manager, "_probe_kohakuterrarium", return_value="2.1.0.dev0"),
                mock.patch("kohaku_loom.sidecar_manager.subprocess.run") as run,
            ):
                source, locked_commit = manager._install_kohakuterrarium()

        self.assertEqual(("github-pinned", KOHakuTERRARIUM_COMMIT), (source, locked_commit))
        self.assertEqual(1, len(run.call_args_list))

    @mock.patch("kohaku_loom.sidecar_manager.os.name", "nt")
    def test_environment_install_uses_plugin_local_config_and_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager = SidecarManager(root)
            manager.paths.python.parent.mkdir(parents=True)
            manager.paths.python.touch()
            with (
                 mock.patch.object(manager, "_install_kohakuterrarium", return_value=("github-pinned", KOHakuTERRARIUM_COMMIT)),
                mock.patch.object(manager, "_probe_kohakuterrarium", return_value="2.1.0.dev0"),
                mock.patch("kohaku_loom.sidecar_manager.subprocess.run") as run,
            ):
                lock = manager.ensure_environment()

        self.assertEqual("github-pinned", lock["source"])
        self.assertEqual(2, lock["capability_level"])
        package_install = run.call_args_list[1]
        self.assertEqual(str(manager.paths.config), package_install.kwargs["env"]["KT_CONFIG_DIR"])
        self.assertEqual(str(manager.paths.sessions), package_install.kwargs["env"]["KT_SESSION_DIR"])

    def test_legacy_ready_lock_is_not_trusted(self):
        self.assertFalse(
            SidecarManager._lock_is_valid({"ready": True, "kohakuterrarium_version": "2.0.0"})
        )

    def test_capability_probe_requires_queue_and_token_apis(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = SidecarManager(Path(directory))
            manager.paths.python.parent.mkdir(parents=True)
            manager.paths.python.touch()
            with mock.patch("kohaku_loom.sidecar_manager.subprocess.run") as run:
                run.return_value.stdout = "2.1.0\n"
                manager._probe_kohakuterrarium()
        probe = run.call_args.args[0][-1]
        self.assertIn("edit_pending", probe)
        self.assertIn("cancel_pending", probe)
        self.assertIn("SessionStore, 'token_usage'", probe)
        self.assertIn("LocalTerrariumService, 'regenerate'", probe)
        self.assertIn("LocalTerrariumService, 'edit_message'", probe)
        self.assertIn("replay_conversation", probe)
        self.assertIn("collect_branch_metadata", probe)
        self.assertIn("collect_user_groups", probe)
        self.assertIn("_reload_conversation_under_branch_view", probe)

    @mock.patch("kohaku_loom.sidecar_manager.os.name", "nt")
    def test_environment_install_reports_locked_runtime_instead_of_raw_access_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager = SidecarManager(root)
            manager.paths.python.parent.mkdir(parents=True)
            manager.paths.python.touch()
            with (
                mock.patch.object(manager, "_install_kohakuterrarium", side_effect=PermissionError(5, "access denied")),
                mock.patch.object(manager, "_probe_kohakuterrarium", return_value="2.1.0.dev0"),
                mock.patch("kohaku_loom.sidecar_manager.subprocess.run"),
            ):
                with self.assertRaisesRegex(RuntimeError, "Stop Forge and retry"):
                    manager.ensure_environment()

    def test_managed_runtime_commands_bypass_forge_uv_subprocess_hook(self):
        with mock.patch("kohaku_loom.sidecar_manager.subprocess.run") as patched_run:
            original_run = mock.Mock(return_value="original")
            with mock.patch.object(subprocess, "__original_run", original_run, create=True):
                result = _run_subprocess(["python", "-m", "pip"])

        self.assertEqual("original", result)
        original_run.assert_called_once_with(["python", "-m", "pip"])
        patched_run.assert_not_called()


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

    async def test_profile_chat_cancellation_closes_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            provider = mock.Mock()
            provider.config.model = "test-model"
            provider.begin_turn = mock.AsyncMock()
            provider.end_turn = mock.AsyncMock()
            provider.close = mock.AsyncMock()
            provider.chat_complete = mock.AsyncMock(side_effect=asyncio.CancelledError())
            runtime._build_provider = mock.Mock(return_value=provider)

            with self.assertRaises(asyncio.CancelledError):
                await runtime.profile_chat("profile", [{"role": "user", "content": "ping"}])

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
                config = mock.Mock(name="loom")
                session_store = mock.Mock(state={})
                session_store.token_usage = mock.Mock(return_value={})

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
            observed = asyncio.Event()
            release = asyncio.Event()

            class Agent:
                config = mock.Mock(name="loom")
                session_store = mock.Mock(state={})
                session_store.token_usage = mock.Mock(return_value={})

                def interrupt(self):
                    return None

            class Creature:
                agent = Agent()

                async def run_stream(self, content, **kwargs):
                    del content, kwargs
                    await provider.observer("reasoning_delta", {"text": "live thought"})
                    observed.set()
                    await release.wait()
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
                    yield TextChunk("late event")

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
                await asyncio.wait_for(observed.wait(), timeout=1)
                snapshot = runtime.status()["active_turn"]
                self.assertEqual("live thought", snapshot["reasoning"])
                release.set()
                await asyncio.wait_for(runtime._turn_task, timeout=1)

        events = runtime.events.after(0)
        self.assertTrue(any(event["type"] == "reasoning_delta" for event in events))
        self.assertTrue(any(event["type"] == "reasoning_snapshot" for event in events))
        self.assertTrue(any(event["type"] == "usage" for event in events))
        self.assertFalse(any(event["type"] == "text_delta" and event["payload"].get("text") == "late event" for event in events))
        self.assertEqual(1, sum(event["type"] == "turn_ended" for event in events))
        self.assertEqual("final thought", runtime._turn_snapshot["reasoning"])
        self.assertEqual({"prompt_tokens": 8, "completion_tokens": 2}, runtime._turn_snapshot["usage"])

    async def test_second_active_session_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = mock.Mock(session_id="active")
            with self.assertRaisesRegex(RuntimeError, "already active"):
                await runtime.open_session("profile", provider=mock.Mock())

    async def test_direct_turn_cannot_bypass_queued_primary(self):
        class Store:
            def __init__(self):
                self.state = {}

            def append_event(self, *args, **kwargs):
                del args, kwargs

        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            store = Store()
            LoomMessageQueue(store, "loom").enqueue("older", kind="primary")
            agent = mock.Mock(config=mock.Mock(name="loom"), session_store=store)
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = mock.Mock(creature=mock.Mock(agent=agent))

            with self.assertRaisesRegex(RuntimeError, "queued Loom message"):
                await runtime.start_turn("newer")

    async def test_active_turn_routes_first_followup_then_five_guides(self):
        class Store:
            def __init__(self):
                self.state = {}

            def append_event(self, *args, **kwargs):
                del args, kwargs

        class Agent:
            def __init__(self):
                self.config = mock.Mock(name="loom")
                self.session_store = Store()
                self.injected = []

            async def inject_input(self, content, source, pending_id):
                self.injected.append((content, source, pending_id))
                return False

        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            agent = Agent()
            runtime.active = mock.Mock(session_id="unit", creature=mock.Mock(agent=agent))
            blocker = asyncio.Event()
            runtime._turn_id = "turn-1"
            runtime._turn_task = asyncio.create_task(blocker.wait())
            try:
                items = [
                    await runtime.enqueue_message("unit", f"message-{index}")
                    for index in range(7)
                ]
            finally:
                runtime._turn_task.cancel()
                await asyncio.gather(runtime._turn_task, return_exceptions=True)

        self.assertEqual(
            ["primary", "guide", "guide", "guide", "guide", "guide", "primary"],
            [item["kind"] for item in items],
        )
        self.assertEqual(5, len(agent.injected))

    async def test_claimed_guides_still_count_toward_turn_limit(self):
        class Store:
            def __init__(self):
                self.state = {}

            def append_event(self, *args, **kwargs):
                del args, kwargs

        class Agent:
            def __init__(self):
                self.config = mock.Mock(name="loom")
                self.session_store = Store()

            async def inject_input(self, content, source, pending_id):
                del content, source, pending_id
                return True

        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = mock.Mock(session_id="unit", creature=mock.Mock(agent=Agent()))
            blocker = asyncio.Event()
            runtime._turn_id = "turn-1"
            runtime._turn_task = asyncio.create_task(blocker.wait())
            try:
                items = [await runtime.enqueue_message("unit", f"message-{index}") for index in range(7)]
            finally:
                runtime._turn_task.cancel()
                await asyncio.gather(runtime._turn_task, return_exceptions=True)

        self.assertEqual(
            ["primary", "guide", "guide", "guide", "guide", "guide", "primary"],
            [item["kind"] for item in items],
        )

    async def test_claimed_guides_settle_with_their_turn(self):
        class Store:
            def __init__(self):
                self.state = {}

            def append_event(self, *args, **kwargs):
                del args, kwargs

        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            store = Store()
            agent = mock.Mock(config=mock.Mock(name="loom"), session_store=store)
            agent.resume = mock.Mock()
            agent.pause = mock.Mock()
            session = mock.Mock(session_id="unit", creature=mock.Mock(agent=agent))
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = session
            runtime._schedule_drain = mock.Mock()
            queue = LoomMessageQueue(store, "loom")
            delivered = queue.enqueue("delivered guide", kind="guide")
            queue.mark(delivered["message_id"], "claimed", turn_id="turn-ok")

            await runtime._settle_turn(session, "turn-ok", {"status": "ok"})

            self.assertEqual("delivered", queue.get(delivered["message_id"])["state"])
            failed = queue.enqueue("failed guide", kind="guide")
            queue.mark(failed["message_id"], "claimed", turn_id="turn-failed")
            await runtime._settle_turn(session, "turn-failed", {"status": "error", "error": "provider failed"})

        failed_item = queue.get(failed["message_id"])
        self.assertEqual("failed", failed_item["state"])
        self.assertEqual("primary", failed_item["kind"])
        self.assertEqual("provider failed", failed_item["error"])

    async def test_failed_primary_head_is_never_auto_drained(self):
        class Store:
            def __init__(self):
                self.state = {}

            def append_event(self, *args, **kwargs):
                del args, kwargs

        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            store = Store()
            queue = LoomMessageQueue(store, "loom")
            failed = queue.enqueue("failed guide", kind="primary")
            queue.mark(failed["message_id"], "failed", error="interrupted")
            agent = mock.Mock(config=mock.Mock(name="loom"), session_store=store)
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = mock.Mock(session_id="unit", creature=mock.Mock(agent=agent))

            await runtime._drain_next()

        self.assertTrue(runtime._paused)
        self.assertFalse(runtime.has_active_turn)
        self.assertEqual("failed", queue.get(failed["message_id"])["state"])
        agent.pause.assert_called_once_with()

    async def test_resumed_session_with_failed_head_stays_paused(self):
        class Store:
            def __init__(self):
                self.state = {}

            def append_event(self, *args, **kwargs):
                del args, kwargs

        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            session_path = paths.sessions / "unit.kohakutr"
            session_path.touch()
            store = Store()
            queue = LoomMessageQueue(store, "loom")
            failed = queue.enqueue("failed", kind="primary")
            queue.mark(failed["message_id"], "failed", error="provider error")
            agent = mock.Mock(config=mock.Mock(name="loom"), session_store=store)
            creature = mock.Mock(agent=agent)
            creature.wait_restoration_ready = mock.AsyncMock()
            engine = mock.Mock()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime._build_session = mock.AsyncMock(return_value=(engine, creature))

            await runtime.open_session("profile", session_id="unit", resume=True, provider=mock.Mock())
            queued = await runtime.enqueue_message("unit", "later")

        self.assertTrue(runtime.status()["queue_paused"])
        self.assertEqual("pending", queued["state"])
        self.assertFalse(runtime.has_active_turn)

    async def test_resumed_session_drains_existing_pending_head(self):
        class Store:
            def __init__(self):
                self.state = {}

            def append_event(self, *args, **kwargs):
                del args, kwargs

        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            session_path = paths.sessions / "unit.kohakutr"
            session_path.touch()
            store = Store()
            queue = LoomMessageQueue(store, "loom")
            pending = queue.enqueue("pending", kind="primary")
            agent = mock.Mock(config=mock.Mock(name="loom"), session_store=store)
            creature = mock.Mock(agent=agent)
            creature.wait_restoration_ready = mock.AsyncMock()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime._build_session = mock.AsyncMock(return_value=(mock.Mock(), creature))
            blocker = asyncio.Event()

            async def run_turn(*args, **kwargs):
                del args, kwargs
                await blocker.wait()

            runtime._run_turn = run_turn
            await runtime.open_session("profile", session_id="unit", resume=True, provider=mock.Mock())
            await asyncio.wait_for(runtime._drain_task, timeout=1)

            self.assertTrue(runtime.has_active_turn)
            self.assertEqual("running", queue.get(pending["message_id"])["state"])
            runtime._turn_task.cancel()
            await asyncio.gather(runtime._turn_task, return_exceptions=True)

    async def test_paused_pending_head_can_be_resumed(self):
        class Store:
            def __init__(self):
                self.state = {}

            def append_event(self, *args, **kwargs):
                del args, kwargs

        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            store = Store()
            queue = LoomMessageQueue(store, "loom")
            pending = queue.enqueue("pending", kind="primary")
            agent = mock.Mock(config=mock.Mock(name="loom"), session_store=store)
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            runtime.active = mock.Mock(session_id="unit", creature=mock.Mock(agent=agent))
            runtime._paused = True
            runtime._schedule_drain = mock.Mock()

            resumed = await runtime.retry_message("unit", pending["message_id"])

        self.assertEqual("pending", resumed["state"])
        self.assertFalse(runtime._paused)
        runtime._schedule_drain.assert_called_once_with()

    async def test_each_new_turn_requires_a_new_primary_followup_before_guides(self):
        class Store:
            def __init__(self):
                self.state = {}

            def append_event(self, *args, **kwargs):
                del args, kwargs

        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            agent = mock.Mock(config=mock.Mock(name="loom"), session_store=Store())
            runtime.active = mock.Mock(session_id="unit", creature=mock.Mock(agent=agent))
            blocker = asyncio.Event()
            runtime._launch_turn(runtime.active, "queued turn", None, message_id="active-message")
            original_task = runtime._turn_task
            original_task.cancel()
            await asyncio.gather(original_task, return_exceptions=True)
            runtime._turn_task = asyncio.create_task(blocker.wait())
            try:
                item = await runtime.enqueue_message("unit", "next")
            finally:
                runtime._turn_task.cancel()
                await asyncio.gather(runtime._turn_task, return_exceptions=True)

        self.assertEqual("primary", item["kind"])

    async def test_launch_turn_replaces_terminal_snapshot_before_task_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            blocker = asyncio.Event()
            store = mock.Mock(state={})
            store.token_usage = mock.Mock(return_value={})
            agent = mock.Mock(config=mock.Mock(name="loom"), session_store=store)
            session = mock.Mock(session_id="unit", creature=mock.Mock(agent=agent))

            async def wait_turn(*args, **kwargs):
                del args, kwargs
                await blocker.wait()

            runtime._run_turn = wait_turn
            runtime.active = session
            runtime._turn_snapshot = {"turn_id": "old", "terminal": {"status": "ok"}}

            accepted = runtime._launch_turn(session, "next", None)
            snapshot = runtime.status()["active_turn"]
            runtime._turn_task.cancel()
            await asyncio.gather(runtime._turn_task, return_exceptions=True)

        self.assertEqual(accepted["turn_id"], snapshot["turn_id"])
        self.assertIsNone(snapshot["terminal"])

    async def test_terminal_turn_remains_explicitly_settling(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = LoomRuntimePaths.under(Path(directory)).ensure()
            runtime = LoomSidecarRuntime(paths, LoomProfileStore(paths), mock.Mock())
            blocker = asyncio.Event()
            store = mock.Mock(state={})
            store.token_usage = mock.Mock(return_value={})
            agent = mock.Mock(config=mock.Mock(name="loom"), session_store=store)
            runtime.active = mock.Mock(session_id="unit", creature=mock.Mock(agent=agent))
            runtime._turn_id = "turn-1"
            runtime._turn_snapshot = {"turn_id": "turn-1", "terminal": {"status": "ok"}}
            runtime._turn_task = asyncio.create_task(blocker.wait())
            try:
                status = runtime.status()
            finally:
                runtime._turn_task.cancel()
                await asyncio.gather(runtime._turn_task, return_exceptions=True)

        self.assertEqual("", status["active_turn_id"])
        self.assertEqual("turn-1", status["settling_turn_id"])


class SidecarApiTests(unittest.TestCase):
    def test_runtime_routes_require_token_and_forward_turns(self):
        class FakeRuntime:
            has_active_turn = False

            def __init__(self):
                async def subscribe(*_args, **_kwargs):
                    if False:
                        yield None

                self.events = mock.Mock(subscribe=subscribe)

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

            def session_metadata(self, session_id, *, refresh=False):
                return {
                    "session_id": session_id,
                    "title": "Portrait planning",
                    "description": "Plans a portrait prompt.",
                    "status": "pending" if not refresh else "generating",
                }

            async def enqueue_message(self, session_id, content, **kwargs):
                return {"message_id": "message-1", "session_id": session_id, "content": content, **kwargs}

            async def edit_message(self, session_id, message_id, content, **kwargs):
                return {"message_id": message_id, "session_id": session_id, "content": content, **kwargs}

            async def cancel_message(self, session_id, message_id):
                return {"message_id": message_id, "session_id": session_id, "state": "cancelled"}

            async def retry_message(self, session_id, message_id):
                return {"message_id": message_id, "session_id": session_id, "state": "pending"}

            async def start_turn(self, content, timeout, operation_id=""):
                return {"turn_id": "turn-1", "status": "accepted", "content": content, "timeout": timeout, "operation_id": operation_id}

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
                queued = client.post(
                    "/sessions/session-1/messages",
                    headers={"Authorization": "Bearer secret-token"},
                    json={"content": "follow up", "display_content": "Follow up"},
                )
                edited = client.patch(
                    "/sessions/session-1/messages/message-1",
                    headers={"Authorization": "Bearer secret-token"},
                    json={"content": "edited"},
                )
                cancelled = client.post(
                    "/sessions/session-1/messages/message-1/cancel",
                    headers={"Authorization": "Bearer secret-token"},
                )
                metadata = client.post(
                    "/sessions/session-1/metadata",
                    headers={"Authorization": "Bearer secret-token"},
                    json={"refresh": True},
                )

        self.assertEqual(200, response.status_code)
        self.assertEqual("turn-1", response.json()["turn_id"])
        self.assertEqual(30.0, response.json()["timeout"])
        self.assertEqual("session-1", history.json()["session"]["session_id"])
        self.assertEqual("ping", profile_chat.json()["text"])
        self.assertEqual(60.0, profile_chat.json()["timeout"])
        self.assertEqual("message-1", queued.json()["message"]["message_id"])
        self.assertEqual("edited", edited.json()["message"]["content"])
        self.assertEqual("cancelled", cancelled.json()["message"]["state"])
        self.assertEqual("generating", metadata.json()["metadata"]["status"])


if __name__ == "__main__":
    unittest.main()
