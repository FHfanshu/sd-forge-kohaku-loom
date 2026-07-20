from __future__ import annotations

import re
import urllib.parse
from typing import Any


GEMINI_NATIVE = "gemini-native"
ANTHROPIC_NATIVE = "anthropic-native"
OPENAI_CHAT_COMPLETIONS = "openai-chat-completions"
REMOTE_HTTP = "remote-http"
LLAMA_ENDPOINT = "llama-endpoint"
LLAMA_ONCE = "llama-once"

SUPPORTED_PROTOCOLS = frozenset({GEMINI_NATIVE, ANTHROPIC_NATIVE, OPENAI_CHAT_COMPLETIONS})
SUPPORTED_RUNTIMES = frozenset({REMOTE_HTTP, LLAMA_ENDPOINT, LLAMA_ONCE})
_PROFILE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$")
_MAX_ENDPOINT_LENGTH = 2048
_MAX_FALLBACK_ENDPOINTS = 8


def normalize_profile(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("profile must be an object")
    profile = dict(payload)
    profile_id = _required(profile, "profile_id", aliases=("id", "profileId"))
    protocol = _required(profile, "protocol")
    runtime = _required(profile, "runtime")
    model = _required(profile, "model", aliases=("model_id", "modelId"))
    if protocol not in SUPPORTED_PROTOCOLS:
        raise ValueError(f"unsupported profile protocol: {protocol}")
    if runtime not in SUPPORTED_RUNTIMES:
        raise ValueError(f"unsupported profile runtime: {runtime}")
    if runtime in {LLAMA_ENDPOINT, LLAMA_ONCE} and protocol != OPENAI_CHAT_COMPLETIONS:
        raise ValueError(f"protocol must be {OPENAI_CHAT_COMPLETIONS!r} for local profiles")

    endpoint = _string(profile, "endpoint")
    if endpoint:
        _validate_url(endpoint)
    if runtime == LLAMA_ONCE and _boolean(profile, "enabled", True) and not _string(profile, "model_path"):
        raise ValueError("model_path is required for llama-once profiles")

    parameters = profile.get("parameters")
    if parameters is None:
        parameters = {}
    if not isinstance(parameters, dict):
        raise ValueError("parameters must be an object")
    result: dict[str, Any] = {
        "profile_id": profile_id,
        "display_name": _string(profile, "display_name", aliases=("displayName", "name")) or profile_id,
        "model_id": model,
        "provider_id": _bounded_text(profile.get("provider_id", profile.get("providerId", "")), "provider_id", maximum=96),
        "enabled": _boolean(profile, "enabled", True),
        "protocol": protocol,
        "runtime": runtime,
        "endpoint": endpoint.rstrip("/"),
        "fallback_endpoints": _string_list(profile.get("fallback_endpoints", profile.get("fallbackEndpoints", []))),
        "capabilities": _capabilities(profile.get("capabilities")),
        "parameters": _parameters(parameters),
        "model_info": _model_info(profile.get("model_info", profile.get("modelInfo", {})) or {}),
        "model_path": _string(profile, "model_path", aliases=("modelPath",)),
        "mmproj_path": _string(profile, "mmproj_path", aliases=("mmprojPath",)),
        "llama_server_path": _string(profile, "llama_server_path", aliases=("llamaServerPath",)),
        "n_ctx": _integer(profile, "n_ctx", 131072, aliases=("nCtx",)),
        "n_gpu_layers": _integer(profile, "n_gpu_layers", -1, aliases=("nGpuLayers",)),
        "thinking": _boolean(profile, "thinking", False),
    }
    return result


def public_profile(profile: dict[str, Any], *, has_api_key: bool) -> dict[str, Any]:
    # Build an allowlist projection instead of copying the internal profile.
    # This prevents future server-owned fields from reaching browser state.
    public = {
        "id": profile["profile_id"],
        "displayName": profile["display_name"],
        "modelId": profile["model_id"],
        "enabled": profile["enabled"],
        "protocol": profile["protocol"],
        "runtime": profile["runtime"],
        "endpoint": profile["endpoint"],
        "fallbackEndpoints": list(profile["fallback_endpoints"]),
        "hasApiKey": bool(has_api_key),
        "has_api_key": bool(has_api_key),
        "capabilities": dict(profile["capabilities"]),
        "parameters": _public_parameters(profile["parameters"]),
        "modelInfo": _public_model_info(profile["model_info"]),
        "localModelConfigured": bool(profile["model_path"]),
        "mmprojConfigured": bool(profile["mmproj_path"]),
        "llamaServerConfigured": bool(profile["llama_server_path"]),
        "nCtx": profile["n_ctx"],
        "nGpuLayers": profile["n_gpu_layers"],
        "thinking": profile["thinking"],
    }
    if profile.get("provider_id"):
        public["providerId"] = profile["provider_id"]
    return public


def _public_parameters(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "temperature": value["temperature"],
        "topP": value["top_p"],
        "maxTokens": value["max_tokens"],
        "reasoningEffort": value["reasoning_effort"],
        "timeout": value["timeout"],
        "sanitizeSensitive": value["sanitize_sensitive"],
        "teacherMode": value["teacher_mode"],
    }


def _public_model_info(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": value["source"],
        "providerId": value["provider_id"],
        "matchedModelId": value["matched_model_id"],
        "contextLimit": value["context_limit"],
        "outputLimit": value["output_limit"],
        "temperatureSupported": value["temperature_supported"],
        "reasoningToggle": value["reasoning_toggle"],
        "reasoningEfforts": list(value["reasoning_efforts"]),
        "syncedAt": value["synced_at"],
    }


def _required(source: dict[str, Any], key: str, aliases: tuple[str, ...] = ()) -> str:
    value = _string(source, key, aliases=aliases)
    if not value:
        raise ValueError(f"{key} is required")
    if key == "profile_id" and not _PROFILE_ID_RE.fullmatch(value):
        raise ValueError("profile_id must be a safe identifier")
    return value


def _string(source: dict[str, Any], key: str, aliases: tuple[str, ...] = ()) -> str:
    value: Any = source.get(key)
    for alias in aliases:
        if value is None:
            value = source.get(alias)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    result = value.strip()
    if key in {"profile_id", "model", "display_name"} and _looks_like_local_path(result):
        raise ValueError(f"{key} must not be a local path")
    return result


def _boolean(source: dict[str, Any], key: str, default: bool) -> bool:
    value = source.get(key, default)
    if not isinstance(value, bool):
        raise ValueError(f"{key} must be a boolean")
    return value


def _integer(source: dict[str, Any], key: str, default: int, aliases: tuple[str, ...] = ()) -> int:
    value: Any = source.get(key)
    for alias in aliases:
        if value is None:
            value = source.get(alias)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{key} must be an integer")
    return value


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        raise ValueError("fallback_endpoints must be a list")
    if len(value) > _MAX_FALLBACK_ENDPOINTS:
        raise ValueError(f"fallback_endpoints must contain at most {_MAX_FALLBACK_ENDPOINTS} items")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValueError("fallback_endpoints must contain non-empty strings")
        endpoint = item.strip().rstrip("/")
        _validate_url(endpoint)
        if endpoint not in result:
            result.append(endpoint)
    return result


def _capabilities(value: Any) -> dict[str, bool]:
    defaults = {
        "tools": True,
        "vision": True,
        "streaming": True,
        "reasoning": True,
        "attachments": True,
        "systemPrompt": True,
        "usage": True,
        "abort": True,
    }
    if value is None:
        return defaults
    if isinstance(value, list):
        return {key: key in value for key in defaults}
    if isinstance(value, dict) and all(isinstance(item, bool) for item in value.values()):
        aliases = {
            "systemPrompt": "system_prompt",
        }
        result: dict[str, bool] = {}
        for key, default in defaults.items():
            fallback = bool(value["vision"]) if key == "attachments" and "attachments" not in value and "vision" in value else default
            result[key] = bool(value.get(key, value.get(aliases.get(key, ""), fallback)))
        return result
    raise ValueError("capabilities must be a list or boolean object")


def _parameters(value: dict[str, Any]) -> dict[str, Any]:
    result = {
        "temperature": float(value.get("temperature", 0.25)),
        "top_p": float(value.get("top_p", value.get("topP", 0.9))),
        "max_tokens": int(value.get("max_tokens", value.get("maxTokens", 8192))),
        "reasoning_effort": str(value.get("reasoning_effort", value.get("reasoningEffort", "low"))),
        "timeout": int(value.get("timeout", 180)),
        "sanitize_sensitive": bool(value.get("sanitize_sensitive", value.get("sanitizeSensitive", True))),
        "teacher_mode": str(value.get("teacher_mode", value.get("teacherMode", "qwen-redact"))),
    }
    if not 0 <= result["temperature"] <= 2 or not 0 <= result["top_p"] <= 1:
        raise ValueError("profile sampling parameters are out of range")
    if result["max_tokens"] <= 0 or result["timeout"] <= 0:
        raise ValueError("profile limits must be positive")
    return result


def _model_info(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("model_info must be an object")
    efforts = value.get("reasoning_efforts", value.get("reasoningEfforts", []))
    if not isinstance(efforts, list) or any(not isinstance(item, str) for item in efforts):
        raise ValueError("model_info.reasoning_efforts must be a list of strings")
    return {
        "source": _bounded_text(value.get("source", ""), "model_info.source"),
        "provider_id": _bounded_text(value.get("provider_id", value.get("providerId", "")), "model_info.provider_id"),
        "matched_model_id": _bounded_text(value.get("matched_model_id", value.get("matchedModelId", "")), "model_info.matched_model_id"),
        "context_limit": _nonnegative_integer(value.get("context_limit", value.get("contextLimit", 0)), "model_info.context_limit"),
        "output_limit": _nonnegative_integer(value.get("output_limit", value.get("outputLimit", 0)), "model_info.output_limit"),
        "temperature_supported": _boolean_value(value.get("temperature_supported", value.get("temperatureSupported", True)), "model_info.temperature_supported"),
        "reasoning_toggle": _boolean_value(value.get("reasoning_toggle", value.get("reasoningToggle", False)), "model_info.reasoning_toggle"),
        "reasoning_efforts": _unique_text_list(efforts, "model_info.reasoning_efforts"),
        "synced_at": _bounded_text(value.get("synced_at", value.get("syncedAt", "")), "model_info.synced_at"),
    }


def _bounded_text(value: Any, field: str, maximum: int = 512) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    result = value.strip()
    if len(result) > maximum or _looks_like_local_path(result):
        raise ValueError(f"{field} contains an unsafe value")
    return result


def _nonnegative_integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


def _boolean_value(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{field} must be a boolean")
    return value


def _unique_text_list(value: list[Any], field: str) -> list[str]:
    result: list[str] = []
    for item in value:
        text = _bounded_text(item, field, maximum=64).lower()
        if text and text not in result:
            result.append(text)
    return result


def _looks_like_local_path(value: str) -> bool:
    return (
        value.startswith(("/", "\\", "./", "../", "~/"))
        or (len(value) > 1 and value[1] == ":")
        or "\\" in value
    )


def _validate_url(value: str) -> None:
    parsed = urllib.parse.urlparse(value)
    if (
        len(value) > _MAX_ENDPOINT_LENGTH
        or parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("endpoint must be an http(s) URL")
