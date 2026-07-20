from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..contracts import StreamRequest
from ..errors import ProviderProxyError
from .common import (
    AdapterCapabilities,
    event,
    image_data,
    iter_sse,
    json_payload,
    normalize_usage,
    parameter,
    sanitized_error_code,
    timeout_seconds,
    tool_definitions,
    usage,
)


_LOGGER = logging.getLogger("prompt_agent.provider_proxy")
ANTHROPIC_CAPABILITIES = AdapterCapabilities()


async def stream_anthropic(request: StreamRequest, profile: dict[str, Any]) -> AsyncIterator[str]:
    endpoint = _messages_url(str(profile["endpoint"]))
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "anthropic-version": "2023-06-01",
    }
    if profile.get("api_key"):
        headers["x-api-key"] = str(profile["api_key"])
    body: dict[str, Any] = {
        "model": profile["model_id"],
        "max_tokens": request.max_tokens if request.max_tokens is not None else int(parameter(profile, "max_tokens", 8192)),
        "messages": _messages(request.messages),
        "stream": True,
    }
    if request.system_prompt:
        body["system"] = [{"type": "text", "text": request.system_prompt}]
    if request.tools:
        body["tools"] = [
            {"name": tool["name"], "description": tool["description"], "input_schema": tool["parameters"]}
            for tool in tool_definitions(request.tools)
        ]
        body["tool_choice"] = {"type": "auto"}
    thinking_enabled = False
    if request.reasoning not in {"off", "none"} and _reasoning_enabled(profile):
        maximum = int(body["max_tokens"])
        budget = min(maximum - 1, max(1024, _reasoning_budget(request.reasoning, maximum)))
        if budget >= 1024:
            body["thinking"] = {"type": "enabled", "budget_tokens": budget}
            thinking_enabled = True
    if not thinking_enabled:
        body["temperature"] = request.temperature if request.temperature is not None else float(parameter(profile, "temperature", 0.35))
        body["top_p"] = request.top_p if request.top_p is not None else float(parameter(profile, "top_p", 0.9))

    usage_value = usage()
    block_types: dict[int, str] = {}
    stop_reason = "stop"
    saw_message_stop = False
    status_code: int | None = None
    error_code = "none"
    started_at = time.monotonic()
    try:
        yield event("start")
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_seconds(profile)), trust_env=True) as client:
            async with client.stream("POST", endpoint, headers=headers, json=body) as response:
                status_code = response.status_code
                response.raise_for_status()
                async for event_name, raw in iter_sse(response):
                    if raw.strip() == "[DONE]":
                        saw_message_stop = True
                        continue
                    try:
                        payload = json_payload(raw)
                    except ValueError as error:
                        raise ProviderProxyError("provider_malformed_response", status_code=status_code) from error
                    if payload.get("error") is not None:
                        raise ProviderProxyError("provider_malformed_response", status_code=status_code)
                    native_event = event_name if event_name != "message" else str(payload.get("type") or "message")
                    if native_event == "message_start":
                        message = payload.get("message") if isinstance(payload.get("message"), dict) else payload
                        raw_usage = message.get("usage") if isinstance(message, dict) else None
                        if isinstance(raw_usage, dict):
                            usage_value = normalize_usage(raw_usage)
                    elif native_event == "content_block_start":
                        index = _index(payload)
                        block = payload.get("content_block") if isinstance(payload.get("content_block"), dict) else {}
                        block_type = str(block.get("type") or "")
                        block_types[index] = block_type
                        if block_type == "text":
                            yield event("text_start", contentIndex=index)
                        elif block_type == "thinking":
                            yield event("thinking_start", contentIndex=index)
                        elif block_type == "tool_use":
                            yield event("toolcall_start", contentIndex=index, id=str(block.get("id") or f"call_{index}"), toolName=str(block.get("name") or "unknown"))
                    elif native_event == "content_block_delta":
                        index = _index(payload)
                        delta = payload.get("delta") if isinstance(payload.get("delta"), dict) else {}
                        delta_type = delta.get("type")
                        if delta_type == "text_delta":
                            yield event("text_delta", contentIndex=index, delta=str(delta.get("text") or ""))
                        elif delta_type == "thinking_delta":
                            yield event("thinking_delta", contentIndex=index, delta=str(delta.get("thinking") or ""))
                        elif delta_type == "input_json_delta":
                            yield event("toolcall_delta", contentIndex=index, delta=str(delta.get("partial_json") or ""))
                    elif native_event == "content_block_stop":
                        index = _index(payload)
                        block_type = block_types.get(index)
                        if block_type == "text":
                            yield event("text_end", contentIndex=index)
                        elif block_type == "thinking":
                            yield event("thinking_end", contentIndex=index)
                        elif block_type == "tool_use":
                            yield event("toolcall_end", contentIndex=index)
                    elif native_event == "message_delta":
                        delta = payload.get("delta") if isinstance(payload.get("delta"), dict) else {}
                        stop_reason = _stop_reason(delta.get("stop_reason"), stop_reason)
                        raw_usage = payload.get("usage")
                        if isinstance(raw_usage, dict):
                            usage_value = _merge_usage(usage_value, raw_usage)
                    elif native_event == "message_stop":
                        saw_message_stop = True
        if not saw_message_stop:
            raise ProviderProxyError("provider_unexpected_eof", status_code=status_code)
        yield event("done", reason=stop_reason, usage=usage_value)
    except asyncio.CancelledError:
        error_code = "request_cancelled"
        raise
    except GeneratorExit:
        error_code = "request_cancelled"
        raise
    except Exception as error:  # noqa: BLE001
        error_code = sanitized_error_code(error)
        raise
    finally:
        _LOGGER.info(
            "provider_proxy request_id=%s provider_id=anthropic status=%s duration_ms=%d error_code=%s",
            request.request_id,
            status_code or 0,
            max(0, int((time.monotonic() - started_at) * 1000)),
            error_code,
        )


def _messages_url(endpoint: str) -> str:
    value = endpoint.strip().rstrip("/")
    if value.endswith("/messages"):
        return value
    return value + "/messages" if value.endswith("/v1") else value + "/v1/messages"


def _messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        if role == "toolResult":
            block = {
                "type": "tool_result",
                "tool_use_id": str(message.get("toolCallId") or ""),
                "content": _user_content(content),
            }
            _append_message(result, "user", [block])
        elif role == "user":
            _append_message(result, "user", _user_content(content))
        elif role == "assistant":
            _append_message(result, "assistant", _assistant_content(content))
    if not result or not any(message["role"] == "user" for message in result):
        raise ValueError("messages must include user content")
    return result


def _append_message(target: list[dict[str, Any]], role: str, content: list[dict[str, Any]]) -> None:
    if not content:
        return
    if target and target[-1]["role"] == role:
        target[-1]["content"].extend(content)
    else:
        target.append({"role": role, "content": content})


def _user_content(content: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    blocks = content if isinstance(content, list) else [{"type": "text", "text": str(content or "")}]
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            result.append({"type": "text", "text": str(block.get("text") or "")})
        elif block.get("type") == "image":
            image = image_data(block)
            if image:
                mime_type, data = image
                result.append({"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": data}})
    return result


def _assistant_content(content: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    blocks = content if isinstance(content, list) else [{"type": "text", "text": str(content or "")}]
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text":
            result.append({"type": "text", "text": str(block.get("text") or "")})
        elif block_type == "thinking":
            thinking = {"type": "thinking", "thinking": str(block.get("thinking") or "")}
            if block.get("thinkingSignature"):
                thinking["signature"] = str(block["thinkingSignature"])
            result.append(thinking)
        elif block_type == "toolCall":
            result.append({
                "type": "tool_use",
                "id": str(block.get("id") or "call_0"),
                "name": str(block.get("name") or "unknown"),
                "input": block.get("arguments") if isinstance(block.get("arguments"), dict) else {},
            })
    return result


def _index(payload: dict[str, Any]) -> int:
    value = payload.get("index", 0)
    return value if isinstance(value, int) and value >= 0 else 0


def _stop_reason(value: Any, current: str) -> str:
    if value == "max_tokens":
        return "length"
    if value == "tool_use":
        return "toolUse"
    if value in {"end_turn", "stop_sequence"}:
        return "stop"
    return current


def _merge_usage(current: dict[str, Any], raw: dict[str, Any]) -> dict[str, Any]:
    normalized = normalize_usage(raw)
    return {
        "input": normalized["input"] or current["input"],
        "output": normalized["output"] or current["output"],
        "cacheRead": normalized["cacheRead"] or current["cacheRead"],
        "cacheWrite": normalized["cacheWrite"] or current["cacheWrite"],
        "totalTokens": (normalized["input"] or current["input"]) + (normalized["output"] or current["output"]),
        "cost": current["cost"],
    }


def _reasoning_budget(level: str, maximum: int) -> int:
    ratios = {"minimal": 0.15, "low": 0.25, "medium": 0.4, "high": 0.6, "xhigh": 0.8, "max": 0.9}
    return max(1024, int(maximum * ratios.get(level, 0.25)))


def _reasoning_enabled(profile: dict[str, Any]) -> bool:
    capabilities = profile.get("capabilities")
    return not isinstance(capabilities, dict) or capabilities.get("reasoning", True)
