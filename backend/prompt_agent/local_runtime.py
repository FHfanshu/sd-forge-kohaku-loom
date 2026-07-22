from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx


class LocalRuntimeError(RuntimeError):
    def __init__(self, code: str, message: str, *, status_code: int = 502):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class LocalLlamaRuntime:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._process: subprocess.Popen[bytes] | None = None
        self._profile_id = ""
        self._signature: tuple[Any, ...] = ()
        self._endpoint = ""
        self._ready_task: asyncio.Task[None] | None = None
        self._started_at = 0.0
        self._turns: dict[str, float] = {}
        self._reapers: dict[str, asyncio.Task[None]] = {}
        self._idle_reaper: asyncio.Task[None] | None = None
        self._unload_after_turn = False
        self._idle_unload_minutes = 30

    async def start_turn(self, turn_id: str, profile: dict[str, Any]) -> dict[str, Any]:
        if profile.get("runtime") != "llama-once":
            raise LocalRuntimeError("invalid_runtime", "The selected profile is not an on-demand local model.", status_code=422)
        command, signature = _server_command(profile)
        timeout = _timeout(profile)
        async with self._lock:
            await self._drop_dead_process_locked()
            if self._process is not None and (self._profile_id != profile["profile_id"] or self._signature != signature):
                if self._turns:
                    raise LocalRuntimeError("local_runtime_busy", "Another local model turn is still active.", status_code=409)
                await self._stop_process_locked()
            if self._process is None:
                port = _free_port()
                self._endpoint = f"http://127.0.0.1:{port}/v1"
                self._process = _spawn(command + ["--port", str(port)])
                self._profile_id = profile["profile_id"]
                self._signature = signature
                self._ready_task = asyncio.create_task(_wait_ready(self._process, self._endpoint, timeout))
                self._started_at = time.monotonic()
            ready_task = self._ready_task
            self._cancel_idle_reaper_locked()
            self._unload_after_turn = bool(profile.get("unload_after_turn", False))
            self._idle_unload_minutes = _idle_unload_minutes(profile)
            self._turns[turn_id] = time.monotonic()
            self._schedule_reaper_locked(turn_id, timeout + 120)
        try:
            if ready_task is not None:
                await ready_task
        except asyncio.CancelledError:
            await self.stop_turn(turn_id, force=True)
            raise
        except BaseException:
            async with self._lock:
                if self._ready_task is ready_task:
                    await self._stop_process_locked()
            raise
        async with self._lock:
            if turn_id not in self._turns or self._process is None or self._process.poll() is not None:
                raise LocalRuntimeError("local_runtime_cancelled", "The local model startup was cancelled.", status_code=409)
            return {"ok": True, "profile_id": self._profile_id, "turn_id": turn_id, "runtime": "llama-once"}

    async def status(self, turn_id: str, profile_id: str) -> dict[str, Any]:
        async with self._lock:
            await self._drop_dead_process_locked()
            if self._process is None or self._profile_id != profile_id or turn_id not in self._turns:
                return {"ok": True, "profile_id": profile_id, "turn_id": turn_id, "phase": "idle", "elapsed_seconds": 0}
            phase = "loading"
            if self._ready_task is not None and self._ready_task.done():
                try:
                    self._ready_task.result()
                    phase = "ready"
                except asyncio.CancelledError:
                    phase = "idle"
                except BaseException:
                    phase = "failed"
            elapsed = max(0, int(time.monotonic() - self._started_at)) if self._started_at else 0
            return {"ok": True, "profile_id": profile_id, "turn_id": turn_id, "phase": phase, "elapsed_seconds": elapsed}

    async def stream_profile(self, turn_id: str, profile: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            await self._drop_dead_process_locked()
            if not turn_id or turn_id not in self._turns or self._profile_id != profile.get("profile_id") or not self._endpoint:
                raise LocalRuntimeError("local_runtime_not_started", "The on-demand local model is not running for this turn.", status_code=409)
            timeout = _timeout(profile)
            self._turns[turn_id] = time.monotonic()
            self._schedule_reaper_locked(turn_id, timeout + 120)
            return {**profile, "endpoint": self._endpoint, "provider_id": "llama-cpp"}

    async def stop_turn(self, turn_id: str, *, force: bool = False) -> dict[str, Any]:
        async with self._lock:
            self._turns.pop(turn_id, None)
            task = self._reapers.pop(turn_id, None)
            if task is not None and task is not asyncio.current_task():
                task.cancel()
            stopped = False
            if self._process is not None and not self._turns:
                if force or self._unload_after_turn:
                    await self._stop_process_locked()
                    stopped = True
                else:
                    self._schedule_idle_reaper_locked()
            return {"ok": True, "turn_id": turn_id, "stopped": stopped}

    async def close(self) -> None:
        async with self._lock:
            await self._stop_process_locked()

    def _schedule_reaper_locked(self, turn_id: str, delay: int) -> None:
        current = self._reapers.pop(turn_id, None)
        if current is not None:
            current.cancel()
        self._reapers[turn_id] = asyncio.create_task(self._reap_stale_turn(turn_id, max(300, delay)))

    def _schedule_idle_reaper_locked(self) -> None:
        self._cancel_idle_reaper_locked()
        if self._idle_unload_minutes > 0:
            self._idle_reaper = asyncio.create_task(self._reap_idle_process(self._idle_unload_minutes * 60))

    def _cancel_idle_reaper_locked(self) -> None:
        if self._idle_reaper is not None and self._idle_reaper is not asyncio.current_task():
            self._idle_reaper.cancel()
        self._idle_reaper = None

    async def _reap_idle_process(self, delay: int) -> None:
        try:
            await asyncio.sleep(delay)
            await self.stop_turn("idle-unload", force=True)
        except asyncio.CancelledError:
            return

    async def _reap_stale_turn(self, turn_id: str, delay: int) -> None:
        try:
            await asyncio.sleep(delay)
            # A turn that outlives its request is no longer safe to keep resident.
            await self.stop_turn(turn_id, force=True)
        except asyncio.CancelledError:
            return

    async def _drop_dead_process_locked(self) -> None:
        if self._process is not None and self._process.poll() is not None:
            await self._clear_process_locked()

    async def _stop_process_locked(self) -> None:
        process = self._process
        await self._clear_process_locked()
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            await asyncio.to_thread(process.wait, 5)
        except subprocess.TimeoutExpired:
            process.kill()
            await asyncio.to_thread(process.wait, 5)

    async def _clear_process_locked(self) -> None:
        self._cancel_idle_reaper_locked()
        if self._ready_task is not None and self._ready_task is not asyncio.current_task():
            self._ready_task.cancel()
        for task in self._reapers.values():
            if task is not asyncio.current_task():
                task.cancel()
        self._reapers.clear()
        self._turns.clear()
        self._process = None
        self._profile_id = ""
        self._signature = ()
        self._endpoint = ""
        self._ready_task = None
        self._started_at = 0.0
        self._unload_after_turn = False
        self._idle_unload_minutes = 30


def _server_command(profile: dict[str, Any]) -> tuple[list[str], tuple[Any, ...]]:
    server = _trusted_server(str(profile.get("llama_server_path") or ""))
    model = _local_file(str(profile.get("model_path") or ""), "model GGUF", suffix=".gguf")
    mmproj = _optional_local_file(str(profile.get("mmproj_path") or ""), "mmproj GGUF", suffix=".gguf")
    draft = _optional_local_file(str(profile.get("draft_model_path") or ""), "draft model GGUF", suffix=".gguf")
    n_ctx = int(profile.get("n_ctx", 16384))
    n_gpu_layers = int(profile.get("n_gpu_layers", -1))
    if not 1024 <= n_ctx <= 1_048_576:
        raise LocalRuntimeError("invalid_profile", "The local context size is invalid.", status_code=422)
    gpu_layers = "all" if n_gpu_layers < 0 else str(n_gpu_layers)
    command = [
        server, "-m", model, "-ngl", gpu_layers, "-c", str(n_ctx), "-fa", "on", "-np", "1",
        "--host", "127.0.0.1", "--alias", str(profile["model_id"]), "--jinja", "--no-ui", "--cache-ram", "0",
        "--reasoning", "on" if profile.get("thinking", False) else "off",
    ]
    if mmproj:
        command.extend(["--mmproj", mmproj])
    if draft:
        command.extend(["--spec-draft-model", draft, "--spec-type", "draft-mtp", "--spec-draft-n-max", "4", "--spec-draft-ngl", "all"])
    signature = (server, model, mmproj, draft, n_ctx, n_gpu_layers, bool(profile.get("thinking", False)), profile["model_id"])
    return command, signature


def _spawn(command: list[str]) -> subprocess.Popen[bytes]:
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        return subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags)
    except OSError as error:
        raise LocalRuntimeError("local_runtime_start_failed", "The local llama.cpp server could not be started.") from error


async def _wait_ready(process: subprocess.Popen[bytes], endpoint: str, timeout: int) -> None:
    deadline = time.monotonic() + max(10, timeout)
    async with httpx.AsyncClient(timeout=httpx.Timeout(2.0), trust_env=False) as client:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise LocalRuntimeError("local_runtime_start_failed", "The local llama.cpp server exited during startup.")
            try:
                response = await client.get(endpoint + "/models")
                if response.status_code < 500:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.5)
    raise LocalRuntimeError("local_runtime_timeout", "The local model did not finish loading before the timeout.", status_code=504)


def _trusted_server(value: str) -> str:
    requested = _path(value)
    candidates = [
        os.environ.get("LLAMA_SERVER_EXE", ""),
        r"E:\AI\lmcpp\llama.cpp\llama-server.exe",
        str(Path(__file__).resolve().parents[2] / "bin" / "llama-server.exe"),
    ]
    trusted = {_path(item).resolve() for item in candidates if item and _path(item).is_file()}
    if not requested.is_file() or requested.resolve() not in trusted:
        raise LocalRuntimeError("invalid_profile", "The configured llama-server executable is not trusted.", status_code=422)
    return str(requested.resolve())


def _local_file(value: str, label: str, *, suffix: str) -> str:
    path = _path(value)
    if not path.is_file() or path.suffix.lower() != suffix:
        raise LocalRuntimeError("invalid_profile", f"The configured {label} was not found.", status_code=422)
    return str(path.resolve())


def _optional_local_file(value: str, label: str, *, suffix: str) -> str:
    return _local_file(value, label, suffix=suffix) if value.strip() else ""


def _path(value: str) -> Path:
    cleaned = value.strip().strip('"')
    if not cleaned or cleaned.replace("/", "\\").startswith("\\\\"):
        return Path("")
    return Path(cleaned)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _timeout(profile: dict[str, Any]) -> int:
    parameters = profile.get("parameters")
    value = parameters.get("timeout", 180) if isinstance(parameters, dict) else 180
    return max(10, min(3600, int(value)))


def _idle_unload_minutes(profile: dict[str, Any]) -> int:
    try:
        value = int(profile.get("idle_unload_minutes", 30))
    except (TypeError, ValueError):
        value = 30
    return max(0, min(1440, value))
