from __future__ import annotations

import gc
import subprocess
import threading
import time
from typing import Any

from .assistant_common import _assistant_estimate_tokens, _assistant_request_messages, _extract_tool_calls
from .constants import DEFAULT_LOCAL_CONTEXT_TOKENS, DEFAULT_LOCAL_TEXT_PRESET
from .llama_runtime import _free_port, _post_local_chat, _wait_server
from .model_paths import resolve_llama_server, resolve_vision_model_pair
from .response_text import _clean_response_text, _extract_message_text
from .utils import _payload_bool


_LOCAL_ASSISTANT_RUNS: dict[str, subprocess.Popen] = {}
_LOCAL_ASSISTANT_CANCELLED: set[str] = set()
_LOCAL_ASSISTANT_RUNS_LOCK = threading.Lock()


def _register_local_assistant_run(run_id: str, proc: subprocess.Popen) -> bool:
    if not run_id:
        return True
    with _LOCAL_ASSISTANT_RUNS_LOCK:
        if run_id in _LOCAL_ASSISTANT_CANCELLED:
            if proc.poll() is None:
                proc.terminate()
            return False
        _LOCAL_ASSISTANT_RUNS[run_id] = proc
    return True


def _unregister_local_assistant_run(run_id: str, proc: subprocess.Popen | None) -> None:
    if not run_id:
        return
    with _LOCAL_ASSISTANT_RUNS_LOCK:
        _LOCAL_ASSISTANT_CANCELLED.discard(run_id)
        if _LOCAL_ASSISTANT_RUNS.get(run_id) is proc:
            _LOCAL_ASSISTANT_RUNS.pop(run_id, None)


def cancel_local_assistant_run(run_id: str) -> dict[str, Any]:
    run_id = str(run_id or "").strip()
    if not run_id:
        return {"ok": False, "error": "run_id is required"}
    with _LOCAL_ASSISTANT_RUNS_LOCK:
        proc = _LOCAL_ASSISTANT_RUNS.pop(run_id, None)
        if not proc:
            _LOCAL_ASSISTANT_CANCELLED.add(run_id)
    if not proc:
        return {"ok": True, "cancelled": False}
    if proc.poll() is None:
        proc.terminate()
        return {"ok": True, "cancelled": True}
    return {"ok": True, "cancelled": False}


def _local_chat_usage(response: dict[str, Any], messages: list[dict[str, str]], output_text: str, elapsed_ms: int, enable_thinking: bool) -> dict[str, Any]:
    raw = response.get("usage") if isinstance(response.get("usage"), dict) else {}
    details = raw.get("completion_tokens_details") if isinstance(raw.get("completion_tokens_details"), dict) else {}
    input_tokens = raw.get("prompt_tokens") or raw.get("input_tokens") or _assistant_estimate_tokens("\n".join(item.get("content", "") for item in messages))
    output_tokens = raw.get("completion_tokens") or raw.get("output_tokens") or _assistant_estimate_tokens(output_text)
    thought_tokens = raw.get("reasoning_tokens") or details.get("reasoning_tokens") or 0
    elapsed_seconds = max(float(elapsed_ms) / 1000.0, 0.001)
    return {
        "input_tokens": int(input_tokens or 0),
        "output_tokens": int(output_tokens or 0),
        "thought_tokens": int(thought_tokens or 0),
        "total_tokens": int(raw.get("total_tokens") or int(input_tokens or 0) + int(output_tokens or 0) + int(thought_tokens or 0)),
        "elapsed_ms": int(elapsed_ms),
        "tokens_per_second": round(float(output_tokens or 0) / elapsed_seconds, 2),
        "thinking_enabled": bool(enable_thinking),
        "stream": False,
        "backend": "local-qwen-once",
    }


def _prompt_assistant_chat_local_once(payload: dict[str, Any]) -> dict[str, Any]:
    messages = payload.get("messages") or []
    if not isinstance(messages, list):
        raise RuntimeError("messages must be a list")
    request_messages = _assistant_request_messages(messages, _payload_bool(payload.get("disable_tools"), False), _payload_bool(payload.get("_session_context"), False))
    preset = str(payload.get("local_text_preset") or payload.get("vision_preset") or DEFAULT_LOCAL_TEXT_PRESET).strip()
    has_image = any(isinstance(item, dict) and (item.get("image") or item.get("data_url") or isinstance(item.get("content"), list)) for item in messages)
    model_path, mmproj_path, alias = resolve_vision_model_pair(
        preset,
        str(payload.get("model_path") or payload.get("local_model_path") or payload.get("vision_model_path") or ""),
        str(payload.get("mmproj_path") or payload.get("vision_mmproj_path") or ""),
        has_image,
    )
    if payload.get("_profile_payload") and payload.get("model"):
        alias = str(payload["model"])
    llama_server_path = resolve_llama_server(str(payload.get("llama_server_path") or ""))
    port = _free_port()
    proc: subprocess.Popen | None = None
    timeout = int(payload.get("timeout") or 120)
    enable_thinking = _payload_bool(payload.get("thinking", payload.get("local_text_thinking", payload.get("enable_thinking"))), False)
    run_id = str(payload.get("run_id") or "").strip()
    try:
        n_gpu_layers = payload.get("local_n_gpu_layers", payload.get("n_gpu_layers", "all"))
        args = [
            llama_server_path,
            "-m",
            model_path,
            "-ngl",
            "all" if str(n_gpu_layers).strip() in {"", "-1", "all"} else str(int(n_gpu_layers)),
            "-c",
            str(int(payload.get("local_n_ctx") or payload.get("n_ctx") or DEFAULT_LOCAL_CONTEXT_TOKENS)),
            "-fa",
            "on",
            "-np",
            "1",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--alias",
            alias,
            "--jinja",
        ]
        if mmproj_path:
            args[3:3] = ["-mm", mmproj_path]
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags)
        if not _register_local_assistant_run(run_id, proc):
            raise RuntimeError("assistant run cancelled")
        endpoint = f"http://127.0.0.1:{port}/v1"
        _wait_server(endpoint, timeout)
        started = time.perf_counter()
        response = _post_local_chat(
            endpoint,
            request_messages,
            int(payload.get("max_tokens") or 2048),
            float(payload.get("temperature") or 0.25),
            float(payload.get("top_p") or 0.9),
            timeout,
            enable_thinking,
            alias,
        )
        message = response["choices"][0]["message"]
        tool_calls = _extract_tool_calls(message)
        text = _clean_response_text(message.get("content", "")) if tool_calls else _extract_message_text(message)
        reasoning = _clean_response_text(message.get("reasoning_content") or message.get("reasoning") or "")
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {"text": text, "reasoning": reasoning, "tool_calls": tool_calls, "model": alias, "endpoint": endpoint, "source": "one-shot-local-qwen", "usage": _local_chat_usage(response, request_messages, text, elapsed_ms, enable_thinking)}
    finally:
        _unregister_local_assistant_run(run_id, proc)
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        gc.collect()
