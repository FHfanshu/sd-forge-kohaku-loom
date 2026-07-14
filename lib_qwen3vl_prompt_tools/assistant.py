from __future__ import annotations

import os
import urllib.parse
from typing import Any, Callable, Iterator

from .assistant_common import _assistant_stream_event
from .assistant_gemini import _prompt_assistant_chat_gemini, _prompt_assistant_stream_gemini
from .assistant_local import _prompt_assistant_chat_local_once
from .assistant_openai import _prompt_assistant_chat_openai, _prompt_assistant_stream_openai
from .assistant_profiles import (
    GEMINI_NATIVE,
    LLAMA_ONCE,
    OPENAI_CHAT_COMPLETIONS,
    normalize_assistant_payload,
)

ChatHandler = Callable[[dict[str, Any], str, str, str], dict[str, Any]]
StreamHandler = Callable[[dict[str, Any], str, str, str], Iterator[str]]


def _chat_gemini(payload: dict[str, Any], endpoint: str, model: str, api_key: str) -> dict[str, Any]:
    return _prompt_assistant_chat_gemini(payload, endpoint, model, api_key)


def _chat_openai(payload: dict[str, Any], endpoint: str, model: str, api_key: str) -> dict[str, Any]:
    return _prompt_assistant_chat_openai(payload, endpoint, model, api_key)


def _stream_gemini(payload: dict[str, Any], endpoint: str, model: str, api_key: str) -> Iterator[str]:
    yield from _prompt_assistant_stream_gemini(payload, endpoint, model, api_key)


def _stream_openai(payload: dict[str, Any], endpoint: str, model: str, api_key: str) -> Iterator[str]:
    yield from _prompt_assistant_stream_openai(payload, endpoint, model, api_key)


PROTOCOL_CHAT_HANDLERS: dict[str, ChatHandler] = {
    GEMINI_NATIVE: _chat_gemini,
    OPENAI_CHAT_COMPLETIONS: _chat_openai,
}
PROTOCOL_STREAM_HANDLERS: dict[str, StreamHandler] = {
    GEMINI_NATIVE: _stream_gemini,
    OPENAI_CHAT_COMPLETIONS: _stream_openai,
}


def _dispatch_assistant_chat(payload: dict[str, Any]) -> dict[str, Any]:
    if payload["runtime"] == LLAMA_ONCE:
        return _prompt_assistant_chat_local_once(payload)
    handler = PROTOCOL_CHAT_HANDLERS[payload["protocol"]]
    return handler(payload, payload["endpoint"], payload["model"], _assistant_api_key(payload))


def _dispatch_assistant_stream(payload: dict[str, Any]) -> Iterator[str]:
    if payload["runtime"] == LLAMA_ONCE:
        try:
            yield _assistant_stream_event("done", _prompt_assistant_chat_local_once(payload))
        except Exception as exc:  # noqa: BLE001
            yield _assistant_stream_event("error", {"error": str(exc)})
        return
    capabilities = payload.get("capabilities") if isinstance(payload.get("capabilities"), dict) else {}
    if capabilities.get("streaming") is False:
        try:
            yield _assistant_stream_event("done", _dispatch_assistant_chat(payload))
        except Exception as exc:  # noqa: BLE001
            yield _assistant_stream_event("error", {"error": str(exc)})
        return
    handler = PROTOCOL_STREAM_HANDLERS[payload["protocol"]]
    yield from handler(payload, payload["endpoint"], payload["model"], _assistant_api_key(payload))


def _prompt_assistant_chat_once(payload: dict[str, Any]) -> dict[str, Any]:
    return _dispatch_assistant_chat(normalize_assistant_payload(payload))


def prompt_assistant_chat(payload: dict[str, Any]) -> dict[str, Any]:
    return _prompt_assistant_chat_once(payload)


def _prompt_assistant_stream_once(payload: dict[str, Any]) -> Iterator[str]:
    try:
        normalized = normalize_assistant_payload(payload)
    except Exception as exc:  # noqa: BLE001
        yield _assistant_stream_event("error", {"error": str(exc)})
        return
    yield from _dispatch_assistant_stream(normalized)


def prompt_assistant_stream(payload: dict[str, Any]) -> Iterator[str]:
    yield from _prompt_assistant_stream_once(payload)


def ask_teacher(payload: dict[str, Any]) -> dict[str, Any]:
    question = str(payload.get("question") or payload.get("teacher_question") or payload.get("prompt") or "").strip()
    context = str(payload.get("context") or payload.get("teacher_context") or "").strip()
    goal = str(payload.get("goal") or "").strip()
    if not question and not context:
        raise RuntimeError("ask_teacher requires question or context")

    parts = [
        "You are a teacher for a local prompt agent. Review the sanitized context and answer with practical "
        "prompt-engineering guidance. Do not request tools, do not expand SAFE_SLOT_### placeholders, and do not "
        "ask for raw sensitive text."
    ]
    if goal:
        parts.append(f"Goal: {goal}")
    if context:
        parts.append(f"Sanitized context:\n{context}")
    if question:
        parts.append(f"Question:\n{question}")

    configured = payload.get("teacher_profile", payload.get("teacher_config"))
    if configured is not None and not isinstance(configured, dict):
        raise RuntimeError("teacher_profile must be an object")
    teacher_payload = dict(configured) if isinstance(configured, dict) else dict(payload)
    for field in (
        "api_key",
        "teacher_mode",
        "sanitize_sensitive",
        "qwen_teacher_enabled",
        "teacher_model_path",
        "teacher_mmproj_path",
        "teacher_n_ctx",
        "teacher_n_gpu_layers",
        "llama_server_path",
    ):
        if field not in teacher_payload and field in payload:
            teacher_payload[field] = payload[field]
    teacher_payload["messages"] = [{"role": "user", "content": "\n\n".join(parts)}]
    teacher_payload["disable_tools"] = True
    parameters = teacher_payload.get("parameters") if isinstance(teacher_payload.get("parameters"), dict) else {}
    teacher_payload["teacher_mode"] = str(teacher_payload.get("teacher_mode") or parameters.get("teacher_mode") or "regex")
    teacher_payload["max_tokens"] = int(
        payload.get("teacher_max_tokens")
        or teacher_payload.get("max_tokens")
        or payload.get("max_tokens")
        or 1200
    )
    normalized = normalize_assistant_payload(teacher_payload)
    normalized["disable_tools"] = True
    result = _dispatch_assistant_chat(normalized)
    return {
        "ok": True,
        "text": result.get("text", ""),
        "model": result.get("model", normalized.get("model", "")),
        "endpoint": result.get("endpoint", normalized.get("endpoint", "")),
        "usage": result.get("usage"),
        "teacher_mode": result.get("teacher_mode", normalized.get("teacher_mode", "regex")),
    }


def _assistant_api_key(payload: dict[str, Any], backend: str = "") -> str:
    explicit = str(payload.get("api_key") or "").strip()
    if explicit or payload.get("_profile_payload"):
        return explicit
    legacy_backend = backend or str(payload.get("_legacy_backend") or "")
    if legacy_backend in {"local-lmcpp", "local-qwen-once"}:
        return ""
    endpoint_host = urllib.parse.urlparse(str(payload.get("endpoint") or "")).netloc.lower()
    moyuu_hosts = {"moyuu.cc", "hk-api.moyuu.cc"}
    if endpoint_host == "api.deepseek.com":
        names = ["DEEPSEEK_API_KEY"]
    elif endpoint_host == "generativelanguage.googleapis.com" and payload.get("protocol") == GEMINI_NATIVE:
        names = ["GEMINI_API_KEY", "GOOGLE_API_KEY"]
    elif endpoint_host in moyuu_hosts:
        names = ["Q3VL_MOYUU_API_KEY", "MOYUU_API_KEY"]
    elif endpoint_host == "api.openai.com" and payload.get("protocol") == OPENAI_CHAT_COMPLETIONS:
        names = ["OPENAI_API_KEY"]
    else:
        names = []
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""
