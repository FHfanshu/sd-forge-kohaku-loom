from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$")
_REASONING_LEVELS = {"off", "none", "minimal", "low", "medium", "high", "xhigh", "max"}


@dataclass(frozen=True)
class StreamRequest:
    profile_id: str
    request_id: str
    system_prompt: str
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]]
    temperature: float | None
    top_p: float | None
    max_tokens: int | None
    reasoning: str


def parse_stream_request(payload: Any) -> StreamRequest:
    if not isinstance(payload, dict):
        raise ValueError("request body must be an object")
    profile_id = _identifier(payload.get("profile_id"), "profile_id", 64)
    request_id = _identifier(payload.get("request_id"), "request_id", 96)
    context = payload.get("context")
    if not isinstance(context, dict):
        raise ValueError("context must be an object")
    system_prompt = str(context.get("systemPrompt") or "")
    if len(system_prompt) > 100_000:
        raise ValueError("systemPrompt is too large")
    messages = context.get("messages")
    tools = context.get("tools", [])
    if not isinstance(messages, list) or len(messages) > 500:
        raise ValueError("messages must be a list with at most 500 items")
    if not isinstance(tools, list) or len(tools) > 64:
        raise ValueError("tools must be a list with at most 64 items")
    if len(str(payload)) > 16 * 1024 * 1024:
        raise ValueError("request body is too large")
    options = payload.get("options") or {}
    if not isinstance(options, dict):
        raise ValueError("options must be an object")
    forbidden = {
        "api_key", "apiKey", "endpoint", "model", "model_path", "modelPath",
        "mmproj_path", "mmprojPath", "llama_server_path", "llamaServerPath",
        "fallback_endpoints", "headers",
    }
    if forbidden.intersection(payload) or forbidden.intersection(options):
        raise ValueError("provider credentials, endpoints, models, headers, and local paths are server-owned")
    temperature = _optional_number(options.get("temperature"), "temperature", 0.0, 2.0)
    top_p = _optional_number(options.get("topP"), "topP", 0.0, 1.0)
    max_tokens = _optional_integer(options.get("maxTokens"), "maxTokens", 1, 1_048_576)
    reasoning = str(options.get("reasoning") or "off").lower()
    if reasoning not in _REASONING_LEVELS:
        raise ValueError("reasoning is invalid")
    return StreamRequest(
        profile_id=profile_id,
        request_id=request_id,
        system_prompt=system_prompt,
        messages=messages,
        tools=tools,
        temperature=temperature,
        top_p=top_p,
        max_tokens=max_tokens,
        reasoning=reasoning,
    )


def _identifier(value: Any, field: str, maximum: int) -> str:
    text = str(value or "")
    if len(text) > maximum or not _IDENTIFIER_RE.fullmatch(text):
        raise ValueError(f"{field} must be a safe identifier")
    return text


def _optional_number(value: Any, field: str, minimum: float, maximum: float) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a number")
    result = float(value)
    if not minimum <= result <= maximum:
        raise ValueError(f"{field} must be between {minimum:g} and {maximum:g}")
    return result


def _optional_integer(value: Any, field: str, minimum: int, maximum: int) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} must be an integer")
    if not minimum <= value <= maximum:
        raise ValueError(f"{field} must be between {minimum} and {maximum}")
    return value
