from __future__ import annotations

import json
import time
import urllib.parse
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from ..contracts import StreamRequest
from ..errors import sanitize_provider_error


CAPABILITY_NAMES = (
    "streaming",
    "tools",
    "vision",
    "reasoning",
    "attachments",
    "systemPrompt",
    "usage",
    "abort",
)


@dataclass(frozen=True)
class AdapterCapabilities:
    streaming: bool = True
    tools: bool = True
    vision: bool = True
    reasoning: bool = True
    attachments: bool = True
    system_prompt: bool = True
    usage: bool = True
    abort: bool = True

    def public(self) -> dict[str, bool]:
        return {
            "streaming": self.streaming,
            "tools": self.tools,
            "vision": self.vision,
            "reasoning": self.reasoning,
            "attachments": self.attachments,
            "systemPrompt": self.system_prompt,
            "usage": self.usage,
            "abort": self.abort,
        }


ALL_CAPABILITIES = AdapterCapabilities()


def capability_report(profile: dict[str, Any], supported: AdapterCapabilities) -> dict[str, Any]:
    declared = profile.get("capabilities")
    declared = declared if isinstance(declared, dict) else {}
    requested = {
        "streaming": _declared(declared, "streaming"),
        "tools": _declared(declared, "tools"),
        "vision": _declared(declared, "vision"),
        "reasoning": _declared(declared, "reasoning"),
        "attachments": _declared(declared, "attachments", fallback=_declared(declared, "vision")),
        "systemPrompt": _declared(declared, "systemPrompt"),
        "usage": _declared(declared, "usage"),
        "abort": _declared(declared, "abort"),
    }
    available = supported.public()
    effective = {name: available[name] and requested[name] for name in CAPABILITY_NAMES}
    unsupported = [name for name in CAPABILITY_NAMES if not effective[name]]
    return {
        "supported": available,
        "effective": effective,
        "unsupported": unsupported,
    }


def _declared(source: dict[str, Any], key: str, *, fallback: bool = True) -> bool:
    value = source.get(key, fallback)
    return value if isinstance(value, bool) else fallback


def requested_capability(request: StreamRequest, profile: dict[str, Any], effective: dict[str, bool]) -> str | None:
    if request.tools and not effective.get("tools", False):
        return "tools"
    if has_attachments(request.messages) and not effective.get("attachments", False):
        return "attachments"
    if has_attachments(request.messages) and not effective.get("vision", False):
        return "vision"
    if request.system_prompt and not effective.get("systemPrompt", False):
        return "systemPrompt"
    if request.reasoning not in {"off", "none"} and not effective.get("reasoning", False):
        return "reasoning"
    if not effective.get("streaming", False):
        return "streaming"
    return None


def has_attachments(messages: list[dict[str, Any]]) -> bool:
    return any(
        isinstance(block, dict) and block.get("type") == "image"
        for message in messages
        if isinstance(message, dict)
        for block in (message.get("content") if isinstance(message.get("content"), list) else [])
    )


def usage(input_tokens: int = 0, output_tokens: int = 0, cache_read: int = 0, cache_write: int = 0) -> dict[str, Any]:
    return {
        "input": input_tokens,
        "output": output_tokens,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "totalTokens": input_tokens + output_tokens,
        "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "total": 0,
        },
    }


def normalize_usage(value: dict[str, Any]) -> dict[str, Any]:
    input_tokens = _integer(value, "prompt_tokens", "input_tokens", "inputTokenCount", "promptTokenCount")
    output_tokens = _integer(value, "completion_tokens", "output_tokens", "outputTokenCount", "candidatesTokenCount")
    prompt_details = value.get("prompt_tokens_details") if isinstance(value.get("prompt_tokens_details"), dict) else {}
    cache_read = _integer(value, "cached_tokens", "cacheRead", "cachedContentTokenCount", "cache_read_input_tokens") or _integer(prompt_details, "cached_tokens")
    cache_write = _integer(value, "cacheWrite", "cache_creation_input_tokens")
    return usage(input_tokens, output_tokens, cache_read, cache_write)


def sanitized_error_code(error: BaseException) -> str:
    return sanitize_provider_error(error).code


def _integer(source: dict[str, Any], *keys: str) -> int:
    for key in keys:
        value = source.get(key)
        if value is not None:
            if isinstance(value, bool):
                raise ValueError("usage value is invalid")
            return max(0, int(value))
    return 0


def event(event_type: str, **payload: Any) -> str:
    return f"data: {json.dumps({'type': event_type, **payload}, ensure_ascii=True)}\n\n"


async def iter_sse(response: Any) -> AsyncIterator[tuple[str, str]]:
    event_name = "message"
    data: list[str] = []
    async for line in response.aiter_lines():
        if line == "":
            if data:
                yield event_name, "\n".join(data)
            event_name = "message"
            data = []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event_name = line[6:].strip() or "message"
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
    if data:
        yield event_name, "\n".join(data)


def json_payload(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise ValueError("provider payload is not valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError("provider payload must be an object")
    return value


def content_blocks(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if not isinstance(content, list):
        return [{"type": "text", "text": str(content or "")}]
    result: list[dict[str, Any]] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type in {"text", "thinking", "image", "toolCall"}:
            result.append(block)
    return result


def text_content(content: Any) -> str:
    return "".join(
        str(block.get("text") or block.get("thinking") or "")
        for block in content_blocks(content)
        if block.get("type") in {"text", "thinking"}
    )


def image_data(block: dict[str, Any]) -> tuple[str, str] | None:
    data = block.get("data")
    mime_type = str(block.get("mimeType") or "application/octet-stream")
    if isinstance(data, str) and data:
        if data.startswith("data:") and ";base64," in data:
            header, data = data.split(",", 1)
            mime_type = header[5:].split(";", 1)[0] or mime_type
        return mime_type, data
    return None


def tool_definitions(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = str(tool.get("name") or "").strip()
        if not name:
            continue
        parameters = tool.get("parameters", tool.get("input_schema", {"type": "object"}))
        result.append({
            "name": name,
            "description": str(tool.get("description") or ""),
            "parameters": parameters if isinstance(parameters, dict) else {"type": "object"},
        })
    return result


def openai_chat_url(endpoint: str) -> str:
    value = endpoint.strip().rstrip("/")
    if value.endswith("/chat/completions"):
        return value
    parsed = urllib.parse.urlparse(value)
    if parsed.netloc.lower() == "api.deepseek.com" or value.endswith("/v1"):
        return value + "/chat/completions"
    return value + "/v1/chat/completions"


def timeout_seconds(profile: dict[str, Any]) -> int:
    parameters = profile.get("parameters")
    configured = parameters.get("timeout", 120) if isinstance(parameters, dict) else 120
    try:
        return min(3600, max(1, int(configured)))
    except (TypeError, ValueError):
        return 120


def parameter(profile: dict[str, Any], key: str, default: Any) -> Any:
    parameters = profile.get("parameters")
    return parameters.get(key, default) if isinstance(parameters, dict) else default


def log_context(request: StreamRequest) -> tuple[str, float]:
    return request.request_id, time.monotonic()
