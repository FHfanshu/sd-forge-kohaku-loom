from __future__ import annotations

import re
import urllib.parse
from typing import Any

from .constants import (
    DEFAULT_ASSISTANT_BACKEND,
    DEFAULT_ASSISTANT_ENDPOINT,
    DEFAULT_ASSISTANT_FALLBACK_ENDPOINT,
    DEFAULT_ASSISTANT_MODEL,
    DEFAULT_LOCAL_ASSISTANT_ENDPOINT,
    DEFAULT_LOCAL_ASSISTANT_MODEL,
)

GEMINI_NATIVE = "gemini-native"
OPENAI_CHAT_COMPLETIONS = "openai-chat-completions"
REMOTE_HTTP = "remote-http"
LLAMA_ENDPOINT = "llama-endpoint"
LLAMA_ONCE = "llama-once"

SUPPORTED_PROTOCOLS = frozenset({GEMINI_NATIVE, OPENAI_CHAT_COMPLETIONS})
SUPPORTED_RUNTIMES = frozenset({REMOTE_HTTP, LLAMA_ENDPOINT, LLAMA_ONCE})

_PROFILE_MARKERS = frozenset({"profile", "profile_id", "protocol", "runtime"})
def is_model_profile_payload(payload: dict[str, Any]) -> bool:
    return any(key in payload for key in _PROFILE_MARKERS)


def normalize_assistant_payload(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError("payload must be an object")
    if is_model_profile_payload(payload):
        return normalize_model_profile(payload)
    return normalize_legacy_assistant_payload(payload)


def normalize_model_profile(payload: dict[str, Any]) -> dict[str, Any]:
    source = _expanded_profile(payload)
    profile_id = _required_string(source, "profile_id")
    protocol = _required_string(source, "protocol")
    runtime = _required_string(source, "runtime")
    if protocol not in SUPPORTED_PROTOCOLS:
        raise RuntimeError(f"protocol must be one of: {', '.join(sorted(SUPPORTED_PROTOCOLS))}; got {protocol!r}")
    if runtime not in SUPPORTED_RUNTIMES:
        raise RuntimeError(f"runtime must be one of: {', '.join(sorted(SUPPORTED_RUNTIMES))}; got {runtime!r}")
    if runtime in {LLAMA_ENDPOINT, LLAMA_ONCE} and protocol != OPENAI_CHAT_COMPLETIONS:
        raise RuntimeError(f"protocol must be {OPENAI_CHAT_COMPLETIONS!r} for runtime {runtime!r}")

    normalized = dict(source)
    parameters = source.get("parameters", {})
    if not isinstance(parameters, dict):
        raise RuntimeError("parameters must be an object")
    normalized.update(parameters)
    normalized.update({key: value for key, value in source.items() if key != "parameters"})
    normalized.update({"profile_id": profile_id, "protocol": protocol, "runtime": runtime, "_profile_payload": True})

    model = _model_value(source)
    endpoint = _optional_string(source, "endpoint")
    if not model:
        raise RuntimeError(f"model/model_id is required for runtime {runtime!r}")
    if runtime in {REMOTE_HTTP, LLAMA_ENDPOINT}:
        if not endpoint:
            raise RuntimeError(f"endpoint is required for runtime {runtime!r}")
        _validate_http_url(endpoint, "endpoint")
    if runtime == LLAMA_ONCE:
        model_path = _optional_string(source, "model_path")
        if not model_path:
            raise RuntimeError("model_path is required for runtime 'llama-once'")
        normalized["model_path"] = model_path
        normalized["local_model_path"] = model_path

    normalized["endpoint"] = endpoint.rstrip("/") if endpoint else ""
    normalized["model"] = model
    normalized["model_id"] = model
    normalized["api_key"] = _optional_string(source, "api_key")
    normalized["fallback_endpoints"] = _fallback_endpoints(source.get("fallback_endpoints", []))
    normalized["messages"] = _messages(source)
    _normalize_capabilities(normalized, source.get("capabilities", []))
    capabilities = normalized["capabilities"]
    if isinstance(capabilities, dict) and capabilities.get("tools") is False:
        normalized["disable_tools"] = True
    elif isinstance(capabilities, list) and capabilities and "tools" not in capabilities:
        normalized["disable_tools"] = True
    if isinstance(capabilities, dict) and capabilities.get("reasoning") is False:
        normalized["reasoning_enabled"] = False
    _normalize_local_fields(normalized, source)
    _validate_parameters(normalized, parameters)
    return normalized


def normalize_legacy_assistant_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(payload)
    parameters = payload.get("parameters")
    if parameters is not None:
        if not isinstance(parameters, dict):
            raise RuntimeError("parameters must be an object")
        normalized.update(parameters)
        normalized.update(payload)
    backend = str(payload.get("backend") or DEFAULT_ASSISTANT_BACKEND).strip()
    if backend == "local-qwen-once":
        runtime = LLAMA_ONCE
        protocol = OPENAI_CHAT_COMPLETIONS
        endpoint = ""
        model = str(payload.get("model") or payload.get("local_text_preset") or "local-qwen").strip()
        model_path = str(payload.get("model_path") or payload.get("local_model_path") or payload.get("vision_model_path") or "").strip()
        if model_path:
            normalized["model_path"] = model_path
    elif backend == "local-lmcpp":
        runtime = LLAMA_ENDPOINT
        protocol = OPENAI_CHAT_COMPLETIONS
        endpoint = str(payload.get("local_endpoint") or payload.get("endpoint") or DEFAULT_LOCAL_ASSISTANT_ENDPOINT).strip().rstrip("/")
        model = str(payload.get("local_model") or payload.get("model") or DEFAULT_LOCAL_ASSISTANT_MODEL).strip()
    else:
        runtime = REMOTE_HTTP
        endpoint = str(payload.get("endpoint") or DEFAULT_ASSISTANT_ENDPOINT).strip().rstrip("/")
        model = str(payload.get("model") or DEFAULT_ASSISTANT_MODEL).strip()
        protocol = GEMINI_NATIVE if _legacy_uses_gemini(backend, endpoint, model) else OPENAI_CHAT_COMPLETIONS

    fallback_value: Any = payload.get("fallback_endpoints")
    if fallback_value is None:
        raw = payload.get("fallback_endpoint")
        if raw is None and protocol == GEMINI_NATIVE:
            raw = DEFAULT_ASSISTANT_FALLBACK_ENDPOINT
        fallback_value = _legacy_fallback_list(raw)
    normalized.update(
        {
            "profile_id": str(payload.get("profile_id") or f"legacy:{backend or 'assistant'}"),
            "protocol": protocol,
            "runtime": runtime,
            "endpoint": endpoint,
            "model": model,
            "model_id": model,
            "fallback_endpoints": _fallback_endpoints(fallback_value),
            "messages": _messages(payload),
            "_legacy_backend": backend,
            "_profile_payload": False,
        }
    )
    _normalize_local_fields(normalized, payload)
    return normalized


def _expanded_profile(payload: dict[str, Any]) -> dict[str, Any]:
    embedded = payload.get("profile")
    if embedded is None:
        return dict(payload)
    if not isinstance(embedded, dict):
        raise RuntimeError("profile must be an object")
    source = dict(embedded)
    source.update({key: value for key, value in payload.items() if key != "profile"})
    return source


def _required_string(payload: dict[str, Any], field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"{field} is required and must be a non-empty string")
    return value.strip()


def _optional_string(payload: dict[str, Any], field: str) -> str:
    value = payload.get(field, "")
    if value is None:
        return ""
    if not isinstance(value, str):
        raise RuntimeError(f"{field} must be a string")
    return value.strip()


def _model_value(payload: dict[str, Any]) -> str:
    model = _optional_string(payload, "model")
    model_id = _optional_string(payload, "model_id")
    if model and model_id and model != model_id:
        raise RuntimeError("model and model_id must match when both are provided")
    return model or model_id


def _messages(payload: dict[str, Any]) -> list[Any]:
    messages = payload.get("messages", [])
    if not isinstance(messages, list):
        raise RuntimeError("messages must be a list")
    return messages


def _fallback_endpoints(value: Any) -> list[str]:
    if not isinstance(value, list):
        raise RuntimeError("fallback_endpoints must be a list")
    result: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            raise RuntimeError(f"fallback_endpoints[{index}] must be a non-empty string")
        endpoint = item.strip().rstrip("/")
        _validate_http_url(endpoint, f"fallback_endpoints[{index}]")
        if endpoint not in seen:
            seen.add(endpoint)
            result.append(endpoint)
    return result


def _legacy_fallback_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [item for item in re.split(r"[,\s]+", str(value).strip()) if item]


def _validate_http_url(value: str, field: str) -> None:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeError(f"{field} must be an http(s) URL")


def _normalize_capabilities(normalized: dict[str, Any], value: Any) -> None:
    if not isinstance(value, (list, dict)):
        raise RuntimeError("capabilities must be a list or object")
    if isinstance(value, list):
        for index, item in enumerate(value):
            if not isinstance(item, str) or not item.strip():
                raise RuntimeError(f"capabilities[{index}] must be a non-empty string")
        normalized["capabilities"] = [item.strip() for item in value]
    else:
        if any(not isinstance(key, str) or not isinstance(item, bool) for key, item in value.items()):
            raise RuntimeError("capabilities object values must be booleans")
        normalized["capabilities"] = dict(value)


def _normalize_local_fields(normalized: dict[str, Any], source: dict[str, Any]) -> None:
    aliases = {
        "mmproj_path": ("mmproj_path", "vision_mmproj_path"),
        "llama_server_path": ("llama_server_path",),
        "n_ctx": ("n_ctx", "local_n_ctx"),
        "thinking": ("thinking", "local_text_thinking", "enable_thinking"),
    }
    for target, names in aliases.items():
        for name in names:
            if name in source and source[name] is not None:
                normalized[target] = source[name]
                break
    for field in ("model_path", "mmproj_path", "llama_server_path"):
        if field in normalized and normalized[field] is not None and not isinstance(normalized[field], str):
            raise RuntimeError(f"{field} must be a string")
    if normalized.get("mmproj_path"):
        normalized["vision_mmproj_path"] = normalized["mmproj_path"]
    if normalized.get("n_ctx") is not None:
        normalized["local_n_ctx"] = normalized["n_ctx"]
    if normalized.get("thinking") is not None:
        normalized["local_text_thinking"] = normalized["thinking"]


def _validate_parameters(normalized: dict[str, Any], parameters: dict[str, Any]) -> None:
    _number_range(normalized, "temperature", 0.0, 2.0)
    _number_range(normalized, "top_p", 0.0, 1.0)
    _integer_range(normalized, "max_tokens", 1, 1048576)
    _integer_range(normalized, "timeout", 1, 3600)
    _integer_range(normalized, "n_ctx", 512, 1048576)
    _integer_range(normalized, "n_gpu_layers", -1, 10000)
    _number_range(normalized, "teacher_temperature", 0.0, 2.0)
    _number_range(normalized, "teacher_top_p", 0.0, 1.0)
    _integer_range(normalized, "teacher_max_tokens", 1, 1048576)
    _integer_range(normalized, "teacher_timeout", 1, 3600)
    _integer_range(normalized, "teacher_n_ctx", 512, 1048576)
    for field in ("thinking", "disable_tools", "sanitize_sensitive", "qwen_teacher_enabled"):
        if field in normalized and normalized[field] is not None and not isinstance(normalized[field], bool):
            raise RuntimeError(f"{field} must be a boolean")
    for field in ("reasoning_effort", "teacher_mode", "run_id"):
        if field in normalized and normalized[field] is not None and not isinstance(normalized[field], str):
            raise RuntimeError(f"{field} must be a string")
    if "reasoning_effort" in normalized and normalized["reasoning_effort"].lower() not in {"none", "minimal", "low", "medium", "high", "xhigh", "max"}:
        raise RuntimeError("reasoning_effort must be one of: none, minimal, low, medium, high, xhigh, max")


def _number_range(payload: dict[str, Any], field: str, minimum: float, maximum: float) -> None:
    if field not in payload or payload[field] is None:
        return
    value = payload[field]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeError(f"{field} must be a number")
    if not minimum <= float(value) <= maximum:
        raise RuntimeError(f"{field} must be between {minimum:g} and {maximum:g}")


def _integer_range(payload: dict[str, Any], field: str, minimum: int, maximum: int) -> None:
    if field not in payload or payload[field] is None:
        return
    value = payload[field]
    if isinstance(value, bool) or not isinstance(value, int):
        raise RuntimeError(f"{field} must be an integer")
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{field} must be between {minimum} and {maximum}")


def _legacy_uses_gemini(backend: str, endpoint: str, model: str) -> bool:
    if backend in {"local-lmcpp", "openai", "openai-compatible", "deepseek"}:
        return False
    if "gemini" in model.lower():
        return True
    host = urllib.parse.urlparse(endpoint).netloc.lower()
    return backend == "moyuu" and host in {"moyuu.cc", "hk-api.moyuu.cc"}


def _assistant_use_gemini_native(backend: str, endpoint: str, model: str) -> bool:
    """Compatibility helper for callers that still construct legacy payloads."""
    return _legacy_uses_gemini(backend, endpoint, model)
