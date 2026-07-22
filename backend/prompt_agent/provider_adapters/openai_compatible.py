from __future__ import annotations

import asyncio
import json
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
    openai_chat_url,
    parameter,
    sanitized_error_code,
    text_content,
    timeout_seconds,
    tool_definitions,
    usage,
)


_LOGGER = logging.getLogger("prompt_agent.provider_proxy")
OPENAI_CAPABILITIES = AdapterCapabilities()


async def stream_openai_compatible(
    request: StreamRequest,
    profile: dict[str, Any],
    *,
    provider_id: str = "openai-compatible",
) -> AsyncIterator[str]:
    endpoint = openai_chat_url(str(profile["endpoint"]))
    headers = {"Content-Type": "application/json"}
    if profile.get("api_key"):
        headers["Authorization"] = f"Bearer {profile['api_key']}"
    body: dict[str, Any] = {
        "model": profile["model_id"],
        "messages": _messages(request.system_prompt, request.messages),
        "stream": True,
        "stream_options": {"include_usage": True},
        "temperature": request.temperature if request.temperature is not None else float(parameter(profile, "temperature", 0.35)),
        "top_p": request.top_p if request.top_p is not None else float(parameter(profile, "top_p", 0.9)),
        "max_tokens": request.max_tokens if request.max_tokens is not None else int(parameter(profile, "max_tokens", 8192)),
    }
    if request.tools:
        body["tools"] = [{"type": "function", "function": tool} for tool in tool_definitions(request.tools)]
        body["tool_choice"] = (
            {"type": "function", "function": {"name": request.tool_choice}}
            if request.tool_choice else "auto"
        )
    if request.reasoning not in {"off", "none"} and _reasoning_enabled(profile):
        body["reasoning_effort"] = request.reasoning

    timeout = timeout_seconds(profile)
    usage_value = usage()
    text_started = False
    thinking_started = False
    tool_calls: dict[int, dict[str, str]] = {}
    finish_reason = "stop"
    upstream_done = False
    saw_finish_reason = False
    status_code: int | None = None
    error_code = "none"
    started_at = time.monotonic()
    try:
        yield event("start")
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout), trust_env=True) as client:
            async with client.stream("POST", endpoint, headers=headers, json=body) as response:
                status_code = response.status_code
                response.raise_for_status()
                async for _, raw in iter_sse(response):
                    if raw.strip() == "[DONE]":
                        upstream_done = True
                        break
                    try:
                        payload = json_payload(raw)
                    except ValueError as error:
                        raise ProviderProxyError("provider_malformed_response", status_code=status_code) from error
                    if payload.get("error") is not None:
                        raise ProviderProxyError("provider_malformed_response", status_code=status_code)
                    if isinstance(payload.get("usage"), dict):
                        try:
                            usage_value = normalize_usage(payload["usage"])
                        except (TypeError, ValueError) as error:
                            raise ProviderProxyError("provider_malformed_response", status_code=status_code) from error
                    choices = payload.get("choices") or []
                    if not choices or not isinstance(choices[0], dict):
                        continue
                    choice = choices[0]
                    raw_finish_reason = choice.get("finish_reason")
                    finish_reason = _finish_reason(raw_finish_reason, finish_reason)
                    saw_finish_reason = saw_finish_reason or isinstance(raw_finish_reason, str) and bool(raw_finish_reason.strip())
                    delta = choice.get("delta")
                    if not isinstance(delta, dict):
                        continue
                    reasoning = _delta_text(delta.get("reasoning_content") or delta.get("reasoning"))
                    if reasoning:
                        if not thinking_started:
                            thinking_started = True
                            yield event("thinking_start", contentIndex=0)
                        yield event("thinking_delta", contentIndex=0, delta=reasoning)
                    text = _delta_text(delta.get("content"))
                    if text:
                        index = 1 if thinking_started else 0
                        if not text_started:
                            text_started = True
                            yield event("text_start", contentIndex=index)
                        yield event("text_delta", contentIndex=index, delta=text)
                    _append_tool_calls(tool_calls, delta)
        if not upstream_done and not saw_finish_reason:
            raise ProviderProxyError("provider_unexpected_eof", status_code=status_code)
        if thinking_started:
            yield event("thinking_end", contentIndex=0)
        if text_started:
            yield event("text_end", contentIndex=1 if thinking_started else 0)
        offset = int(thinking_started) + int(text_started)
        for position, call in enumerate(tool_calls.values(), start=offset):
            arguments = call["arguments"] or "{}"
            yield event("toolcall_start", contentIndex=position, id=call["id"] or f"call_{position}", toolName=call["name"] or "unknown")
            yield event("toolcall_delta", contentIndex=position, delta=arguments)
            yield event("toolcall_end", contentIndex=position)
        yield event("done", reason="toolUse" if tool_calls else finish_reason, usage=usage_value)
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
            "provider_proxy request_id=%s provider_id=%s status=%s duration_ms=%d error_code=%s",
            request.request_id,
            provider_id,
            status_code or 0,
            max(0, int((time.monotonic() - started_at) * 1000)),
            error_code,
        )


def _messages(system_prompt: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if system_prompt:
        result.append({"role": "system", "content": system_prompt})
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        if role in {"system", "user"}:
            result.append({"role": role, "content": _content(content)})
        elif role == "assistant":
            blocks = content if isinstance(content, list) else []
            text = "".join(str(block.get("text") or "") for block in blocks if isinstance(block, dict) and block.get("type") == "text")
            reasoning = "".join(str(block.get("thinking") or "") for block in blocks if isinstance(block, dict) and block.get("type") == "thinking")
            calls = [block for block in blocks if isinstance(block, dict) and block.get("type") == "toolCall"]
            item: dict[str, Any] = {"role": "assistant", "content": text or None}
            if reasoning:
                item["reasoning_content"] = reasoning
            if calls:
                item["tool_calls"] = [
                    {
                        "id": str(call.get("id") or "call_0"),
                        "type": "function",
                        "function": {
                            "name": str(call.get("name") or "unknown"),
                            "arguments": json.dumps(call.get("arguments") or {}, ensure_ascii=True),
                        },
                    }
                    for call in calls
                ]
            result.append(item)
        elif role == "toolResult":
            result.append({
                "role": "tool",
                "tool_call_id": str(message.get("toolCallId") or ""),
                "content": text_content(content),
            })
    if not result or all(item["role"] == "system" for item in result):
        raise ValueError("messages must include user content")
    return result


def _content(content: Any) -> Any:
    blocks = []
    for block in _blocks(content):
        if block.get("type") == "text":
            blocks.append({"type": "text", "text": str(block.get("text") or "")})
        elif block.get("type") == "image":
            image = image_data(block)
            if image:
                mime_type, data = image
                blocks.append({"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{data}"}})
    if len(blocks) == 1 and blocks[0]["type"] == "text":
        return blocks[0]["text"]
    return blocks


def _blocks(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return content if isinstance(content, list) else [{"type": "text", "text": str(content or "")}]


def _append_tool_calls(target: dict[int, dict[str, str]], delta: dict[str, Any]) -> None:
    calls = delta.get("tool_calls") or []
    for fallback, call in enumerate(calls):
        if not isinstance(call, dict):
            continue
        index = call.get("index") if isinstance(call.get("index"), int) else fallback
        current = target.setdefault(index, {"id": "", "name": "", "arguments": ""})
        current["id"] += str(call.get("id") or "")
        function = call.get("function") if isinstance(call.get("function"), dict) else {}
        current["name"] += str(function.get("name") or "")
        current["arguments"] += str(function.get("arguments") or "")


def _delta_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(str(item.get("text") or "") for item in value if isinstance(item, dict))
    if isinstance(value, dict):
        return str(value.get("text") or "")
    return ""


def _finish_reason(value: Any, current: str) -> str:
    if value in {"length", "max_tokens"}:
        return "length"
    if value in {"tool_calls", "function_call"}:
        return "toolUse"
    if value in {"stop", "end_turn"}:
        return "stop"
    return current


def _reasoning_enabled(profile: dict[str, Any]) -> bool:
    capabilities = profile.get("capabilities")
    return not isinstance(capabilities, dict) or capabilities.get("reasoning", True)
