from __future__ import annotations

import asyncio
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from backend.prompt_agent.local_runtime import LocalLlamaRuntime, _server_command
from quality.acceptance import acceptance


class Process:
    def __init__(self):
        self.returncode = None
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, _timeout=None):
        if self.returncode is None:
            raise subprocess.TimeoutExpired("llama-server", 5)
        return self.returncode


def profile(root: Path, *, unload: bool = False, idle_minutes: int = 30) -> dict:
    server = root / "llama-server.exe"
    model = root / "model.gguf"
    mmproj = root / "mmproj.gguf"
    draft = root / "draft.gguf"
    for path in (server, model, mmproj, draft):
        path.write_bytes(b"x")
    return {
        "profile_id": "local",
        "display_name": "Local",
        "model_id": "gemma-4-12b-it",
        "enabled": True,
        "protocol": "openai-chat-completions",
        "runtime": "llama-once",
        "model_path": str(model),
        "mmproj_path": str(mmproj),
        "draft_model_path": str(draft),
        "llama_server_path": str(server),
        "n_ctx": 16384,
        "n_gpu_layers": -1,
        "thinking": False,
        "unload_after_turn": unload,
        "idle_unload_minutes": idle_minutes,
        "parameters": {"timeout": 30},
    }


class LocalRuntimeTests(unittest.TestCase):
    def test_command_uses_loopback_gpu_vision_and_mtp(self):
        with TemporaryDirectory() as directory:
            item = profile(Path(directory))
            with patch("backend.prompt_agent.local_runtime._trusted_server", return_value=item["llama_server_path"]):
                command, _signature = _server_command(item)
        joined = " ".join(command)
        self.assertIn("-ngl all", joined)
        self.assertIn("--host 127.0.0.1", joined)
        self.assertIn("--mmproj", command)
        self.assertIn("--spec-draft-model", command)
        self.assertIn("--spec-type draft-mtp", joined)
        self.assertIn("--cache-ram 0", joined)

    def test_default_resident_mode_reuses_process_and_immediate_mode_unloads(self):
        async def run(unload: bool):
            with TemporaryDirectory() as directory:
                item = profile(Path(directory), unload=unload)
                process = Process()
                runtime = LocalLlamaRuntime()
                with (
                    patch("backend.prompt_agent.local_runtime._trusted_server", return_value=item["llama_server_path"]),
                    patch("backend.prompt_agent.local_runtime._spawn", return_value=process) as spawn,
                    patch("backend.prompt_agent.local_runtime._wait_ready", new=AsyncMock()),
                ):
                    await runtime.start_turn("turn-1", item)
                    routed = await runtime.stream_profile("turn-1", item)
                    first = await runtime.stop_turn("turn-1")
                    if not unload:
                        await runtime.start_turn("turn-2", item)
                        await runtime.stop_turn("turn-2", force=True)
                    return process, spawn.call_count, routed, first

        unloaded, unload_starts, routed, result = asyncio.run(run(True))
        self.assertEqual("llama-once", routed["runtime"])
        self.assertEqual("llama-cpp", routed["provider_id"])
        self.assertTrue(result["stopped"])
        self.assertTrue(unloaded.terminated)
        self.assertEqual(1, unload_starts)

        resident, resident_starts, _routed, result = asyncio.run(run(False))
        self.assertFalse(result["stopped"])
        self.assertEqual(1, resident_starts)
        self.assertTrue(resident.terminated)

    def test_idle_reaper_unloads_resident_process(self):
        async def run():
            with TemporaryDirectory() as directory:
                item = profile(Path(directory), idle_minutes=1)
                process = Process()
                runtime = LocalLlamaRuntime()
                real_sleep = asyncio.sleep

                async def idle_sleep(delay):
                    if delay < 60:
                        await real_sleep(0)
                    elif delay < 300:
                        return
                    else:
                        await asyncio.Event().wait()

                with (
                    patch("backend.prompt_agent.local_runtime._trusted_server", return_value=item["llama_server_path"]),
                    patch("backend.prompt_agent.local_runtime._spawn", return_value=process),
                    patch("backend.prompt_agent.local_runtime._wait_ready", new=AsyncMock()),
                    patch("backend.prompt_agent.local_runtime.asyncio.sleep", side_effect=idle_sleep),
                ):
                    await runtime.start_turn("turn-1", item)
                    await runtime.stop_turn("turn-1")
                    await runtime._idle_reaper
                    return process

        process = asyncio.run(run())
        self.assertTrue(process.terminated)

    @acceptance("LOCAL-RUNTIME-001@1", "abort")
    def test_force_stop_terminates_while_model_is_loading(self):
        async def run():
            with TemporaryDirectory() as directory:
                item = profile(Path(directory))
                process = Process()
                loading = asyncio.Event()
                release = asyncio.Event()

                async def wait_ready(*_args):
                    loading.set()
                    await release.wait()

                runtime = LocalLlamaRuntime()
                with (
                    patch("backend.prompt_agent.local_runtime._trusted_server", return_value=item["llama_server_path"]),
                    patch("backend.prompt_agent.local_runtime._spawn", return_value=process),
                    patch("backend.prompt_agent.local_runtime._wait_ready", side_effect=wait_ready),
                ):
                    startup = asyncio.create_task(runtime.start_turn("turn-loading", item))
                    await asyncio.wait_for(loading.wait(), timeout=1)
                    stopped = await runtime.stop_turn("turn-loading", force=True)
                    release.set()
                    with self.assertRaises(asyncio.CancelledError):
                        await startup
                    return process, stopped, runtime

        process, stopped, runtime = asyncio.run(run())
        self.assertTrue(stopped["stopped"])
        self.assertTrue(process.terminated)
        self.assertIsNone(runtime._process)

    @acceptance("LOCAL-RUNTIME-001@1", "loading,privacy")
    @acceptance("UI-FEEDBACK-001@3", "recovery")
    def test_status_reports_loading_ready_and_idle_without_local_paths(self):
        async def run():
            with TemporaryDirectory() as directory:
                item = profile(Path(directory))
                process = Process()
                loading = asyncio.Event()
                release = asyncio.Event()

                async def wait_ready(*_args):
                    loading.set()
                    await release.wait()

                runtime = LocalLlamaRuntime()
                with (
                    patch("backend.prompt_agent.local_runtime._trusted_server", return_value=item["llama_server_path"]),
                    patch("backend.prompt_agent.local_runtime._spawn", return_value=process),
                    patch("backend.prompt_agent.local_runtime._wait_ready", side_effect=wait_ready),
                ):
                    startup = asyncio.create_task(runtime.start_turn("turn-status", item))
                    await asyncio.wait_for(loading.wait(), timeout=1)
                    loading_status = await runtime.status("turn-status", "local")
                    release.set()
                    await startup
                    ready_status = await runtime.status("turn-status", "local")
                    await runtime.stop_turn("turn-status", force=True)
                    idle_status = await runtime.status("turn-status", "local")
                    return loading_status, ready_status, idle_status

        loading, ready, idle = asyncio.run(run())
        self.assertEqual("loading", loading["phase"])
        self.assertEqual("ready", ready["phase"])
        self.assertEqual("idle", idle["phase"])
        self.assertNotIn("model_path", loading)
        self.assertNotIn("endpoint", loading)

    def test_stale_turn_reaper_forces_process_reclaim(self):
        async def run():
            runtime = LocalLlamaRuntime()
            runtime.stop_turn = AsyncMock()
            with patch("backend.prompt_agent.local_runtime.asyncio.sleep", new=AsyncMock()):
                await runtime._reap_stale_turn("stale-turn", 300)
            return runtime.stop_turn

        stop_turn = asyncio.run(run())
        stop_turn.assert_awaited_once_with("stale-turn", force=True)

    def test_idle_unload_minutes_is_validated_and_defaulted(self):
        from backend.prompt_agent.profile_contracts import normalize_profile

        normalized = normalize_profile({
            "profile_id": "local",
            "protocol": "openai-chat-completions",
            "runtime": "llama-once",
            "model": "gemma",
            "model_path": "C:/models/gemma.gguf",
        })
        self.assertFalse(normalized["unload_after_turn"])
        self.assertEqual(30, normalized["idle_unload_minutes"])
        with self.assertRaises(ValueError):
            normalize_profile({**normalized, "idle_unload_minutes": 1441})


if __name__ == "__main__":
    unittest.main()
